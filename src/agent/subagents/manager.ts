import { randomUUID } from "node:crypto";
import type {
  StreamEvent,
  StreamSubagentLiveEvent,
  StreamToolCallEvent,
} from "../../llm/streamEvents.js";
import { agentLogInfo, agentLogWarn } from "../../logging/agentLog.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { getDefaultSubagentSystemPrompt } from "../../settings/promptDefaults.js";
import type { Session } from "../../session/types.js";
import type { SessionDatabase } from "../../session/db/openDb.js";
import {
  replaceSubagentMessages,
  upsertSubagentRun,
  type SubagentRunRecord,
} from "../../session/db/subagentRepository.js";
import type { PermissionGateState } from "../../tools/types.js";
import type { HookRunner } from "../../hooks/types.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "../types.js";
import {
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SUBAGENT_MODEL_ITERATIONS,
  MAX_SUBAGENTS_PER_TURN,
  SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_LIVE_MAX_TEXT_CHARS,
  SUBAGENT_LIVE_TEXT_FLUSH_MS,
  SUBAGENT_LIVE_TOOL_SUMMARY_CHARS,
  normalizeSubagentPriority,
  normalizeSubagentRole,
} from "./constants.js";
import {
  buildSubagentTranscript,
  extractSubagentResult,
  nameFromPrompt,
  normalizeSubagentName,
  parseSubagentResultPayload,
} from "./summary.js";
import { buildSubagentSystemPrompt } from "./systemPrompt.js";
import { subagentToolPredicate } from "./toolFilter.js";
import type {
  AwaitSubagentEntry,
  DispatchSubagentInput,
  DispatchSubagentResult,
  GetBatchResultOutcome,
  StopSubagentEntry,
  SubagentBatchEntry,
  SubagentBatchResult,
  SubagentDetailSnapshot,
  SubagentHost,
  SubagentRun,
  SubagentRunStatus,
  SubagentRunSummary,
  SubagentStatusSnapshot,
  SubagentTranscript,
} from "./types.js";

const managersByParentSession = new Map<string, SubagentManager>();

export function getSubagentManager(
  parentSessionId: string,
): SubagentManager | undefined {
  return managersByParentSession.get(parentSessionId);
}

export type CreateSubagentManagerInput = {
  parentSession: Session;
  parentSignal?: AbortSignal;
  client: RunAgentTurnInput["client"];
  gate: PermissionGateState;
  createId: () => string;
  maxModelIterations?: number;
  maxTurnTokens?: number;
  /** When true (parent Infinite switch), child turns skip iterations/tokens caps. */
  unlimitedTurnBudgets?: boolean;
  contextLimitTokens?: number;
  compactTriggerRatio?: number;
  iterationProtectRawIterationCount?: number;
  iterationProtectTokenRatio?: number;
  /** Optional override for SUBAGENT.md (tests); default loads from prompts dir. */
  subagentSystemPrompt?: string;
  environmentContext?: RunAgentTurnInput["environmentContext"];
  getVisionClient?: RunAgentTurnInput["getVisionClient"];
  getImageGenClient?: RunAgentTurnInput["getImageGenClient"];
  uploadImageGenInput?: RunAgentTurnInput["uploadImageGenInput"];
  hooks?: HookRunner;
  streamChat?: RunAgentTurnInput["streamChat"];
  summarize?: RunAgentTurnInput["summarize"];
  onParentEvent?: (event: StreamEvent) => void;
  /** When set, subagent runs/messages are written to sessions.sqlite. */
  db?: SessionDatabase;
  /** Parent turn's LLM bundle (child uses `.subagent` binding). */
  llmBundle?: RunAgentTurnInput["llmBundle"];
  /** All agent sessions across workspaces (search_session_history). */
  listAgentSessions?: RunAgentTurnInput["listAgentSessions"];
  /** Summarized session_history records (search_session_history scope). */
  listSessionHistory?: RunAgentTurnInput["listSessionHistory"];
  /** Known workspaces (id + name) for search_session_history scoping. */
  listWorkspaces?: RunAgentTurnInput["listWorkspaces"];
  /** Graph library port forwarded to child turns (fsm_graph). */
  fsmGraphLibrary?: RunAgentTurnInput["fsmGraphLibrary"];
  /** Loops service port forwarded to child turns (loops tool). */
  loops?: RunAgentTurnInput["loops"];
  /** Injected to avoid circular imports with runAgentTurn. */
  runTurn: (input: RunAgentTurnInput) => Promise<RunAgentTurnResult>;
};

type BatchState = {
  runIds: string[];
  /** False while parent may still dispatch more into this batch (same tool round). */
  sealed: boolean;
  delivered: boolean;
};

function isTerminal(status: SubagentRunStatus): boolean {
  return (
    status === "completed" ||
    status === "error" ||
    status === "cancelled"
  );
}

function truncateLiveText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Argument keys shown first in live tool lines (most informative). */
const LIVE_TOOL_SUMMARY_PREFERRED_KEYS = [
  "path",
  "file_path",
  "command",
  "pattern",
  "query",
  "url",
  "prompt",
  "id",
  "name",
];

function summarizeToolArguments(
  args: StreamToolCallEvent["arguments"],
): string {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return "";
  const ordered = [
    ...entries.filter(([key]) =>
      LIVE_TOOL_SUMMARY_PREFERRED_KEYS.includes(key),
    ),
    ...entries.filter(
      ([key]) => !LIVE_TOOL_SUMMARY_PREFERRED_KEYS.includes(key),
    ),
  ];
  const parts: string[] = [];
  for (const [key, value] of ordered) {
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
    if (!text) continue;
    parts.push(`${key}: ${text}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" · ");
}

function toSnapshot(run: SubagentRun): SubagentStatusSnapshot {
  const snap: SubagentStatusSnapshot = {
    id: run.id,
    batchId: run.batchId,
    name: run.name,
    role: run.role,
    priority: run.priority,
    status: run.status,
    progressText: run.progressText,
    parentToolCallId: run.parentToolCallId,
  };
  if (run.resultSummary) snap.summary = run.resultSummary;
  if (run.errorMessage) snap.errorMessage = run.errorMessage;
  return snap;
}

function toDetail(run: SubagentRun): SubagentDetailSnapshot {
  return {
    ...toSnapshot(run),
    prompt: run.prompt,
    messages: buildSubagentTranscript(run.session),
  };
}

/** Status snapshot + timestamps — Subagents window tab list item. */
function toSummary(run: SubagentRun): SubagentRunSummary {
  return {
    ...toSnapshot(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toBatchEntry(run: SubagentRun): SubagentBatchEntry {
  const entry: SubagentBatchEntry = {
    id: run.id,
    name: run.name,
    priority: run.priority,
    status: run.status,
  };
  if (run.resultSummary) entry.summary = run.resultSummary;
  if (run.errorMessage) entry.errorMessage = run.errorMessage;
  return entry;
}

function toRunRecord(run: SubagentRun): SubagentRunRecord {
  return {
    id: run.id,
    parentSessionId: run.parentSessionId,
    parentToolCallId: run.parentToolCallId,
    batchId: run.batchId,
    name: run.name,
    prompt: run.prompt,
    role: run.role,
    priority: run.priority,
    status: run.status,
    progressText: run.progressText,
    ...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function entryPayloadFields(summaryJson: string | undefined): Record<string, unknown> {
  if (!summaryJson) return {};
  const payload = parseSubagentResultPayload(summaryJson);
  return {
    result: payload.result,
    attachment: payload.attachment,
    table: payload.table,
  };
}

/** Format batch results as compact JSON for the parent LLM. */
export function formatSubagentBatchResultText(
  result: SubagentBatchResult,
): string {
  return JSON.stringify({
    batch_id: result.batchId,
    entries: result.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      priority: entry.priority,
      status: entry.status,
      ...(entry.errorMessage ? { error: entry.errorMessage } : {}),
      ...entryPayloadFields(entry.summary),
    })),
  });
}

export class SubagentManager implements SubagentHost {
  private readonly runs = new Map<string, SubagentRun>();
  private readonly batches = new Map<string, BatchState>();
  private readonly inbox: SubagentBatchResult[] = [];
  private readonly waitListeners = new Set<() => void>();
  private readonly resolveDoneById = new Map<string, () => void>();
  private readonly startedIds = new Set<string>();
  /** Live monitor text buffer per run (throttled flush, ~120ms). */
  private readonly liveTextById = new Map<
    string,
    {
      buf: string;
      kind: "delta" | "reasoning";
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  /** Live monitor tool lines per run (toolCallId → summary), for finish flips. */
  private readonly liveToolsByRunId = new Map<
    string,
    Map<string, { id: string; name: string; summary: string }>
  >();
  private createdThisTurn = 0;
  private readonly parentSessionId: string;

  constructor(private readonly input: CreateSubagentManagerInput) {
    this.parentSessionId = input.parentSession.id;
    managersByParentSession.set(this.parentSessionId, this);
  }

  asHost(): SubagentHost {
    return this;
  }

  dispose(): void {
    this.stopAll();
    this.sealOpenBatches();
    this.flushAllPersistence();
    for (const state of this.liveTextById.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    this.liveTextById.clear();
    this.liveToolsByRunId.clear();
    this.notifyWaiters();
    if (managersByParentSession.get(this.parentSessionId) === this) {
      managersByParentSession.delete(this.parentSessionId);
    }
  }

  getDetail(id: string): SubagentDetailSnapshot | null {
    const run = this.runs.get(id);
    return run ? toDetail(run) : null;
  }

  /** Raw transcript (full Message[]) — Subagents window rendering path. */
  getTranscript(id: string): SubagentTranscript | null {
    const run = this.runs.get(id);
    if (!run) return null;
    return { run: toSummary(run), messages: run.session.messages };
  }

  /** All runs this manager knows (queued/running/terminal), newest last. */
  listSummaries(): SubagentRunSummary[] {
    return [...this.runs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toSummary);
  }

  list(includeFinished = false): SubagentStatusSnapshot[] {
    const out: SubagentStatusSnapshot[] = [];
    for (const run of this.runs.values()) {
      if (
        !includeFinished &&
        run.status !== "queued" &&
        run.status !== "running"
      ) {
        continue;
      }
      out.push(toSnapshot(run));
    }
    return out;
  }

  getStatus(ids?: string[]): SubagentStatusSnapshot[] {
    if (!ids || ids.length === 0) {
      return this.list(true);
    }
    const out: SubagentStatusSnapshot[] = [];
    for (const id of ids) {
      const run = this.runs.get(id.trim());
      if (run) out.push(toSnapshot(run));
    }
    return out;
  }

  /** Count only actively executing children (not queued). */
  private activeRunningCount(): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.status === "running") n += 1;
    }
    return n;
  }

  private notifyWaiters(): void {
    for (const listener of [...this.waitListeners]) {
      listener();
    }
  }

  private batchAllTerminal(batch: BatchState): boolean {
    if (batch.runIds.length === 0) return false;
    for (const id of batch.runIds) {
      const run = this.runs.get(id);
      if (!run || !isTerminal(run.status)) return false;
    }
    return true;
  }

  /** If sealed and all terminal and not delivered, push inbox once. */
  private maybeEnqueueBatch(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch || batch.delivered || !batch.sealed) return;
    if (!this.batchAllTerminal(batch)) return;
    if (this.inbox.some((item) => item.batchId === batchId)) return;

    const entries: SubagentBatchEntry[] = [];
    for (const id of batch.runIds) {
      const run = this.runs.get(id);
      if (run) entries.push(toBatchEntry(run));
    }
    this.inbox.push({ batchId, entries });
    this.notifyWaiters();
    agentLogInfo("subagent.batch.ready", {
      parentSessionId: this.parentSessionId,
      batchId,
      count: entries.length,
    });
  }

  sealOpenBatches(): void {
    for (const [batchId, batch] of this.batches) {
      if (batch.sealed) continue;
      batch.sealed = true;
      this.maybeEnqueueBatch(batchId);
    }
    this.notifyWaiters();
  }

  hasIncompleteBatches(): boolean {
    for (const batch of this.batches.values()) {
      if (batch.delivered) continue;
      return true;
    }
    return false;
  }

  drainInbox(): SubagentBatchResult[] {
    if (this.inbox.length === 0) return [];
    const out = this.inbox.splice(0, this.inbox.length);
    for (const item of out) {
      const batch = this.batches.get(item.batchId);
      if (batch) batch.delivered = true;
    }
    this.notifyWaiters();
    return out;
  }

  private buildBatchResult(batchId: string, batch: BatchState): SubagentBatchResult {
    const entries: SubagentBatchEntry[] = [];
    for (const id of batch.runIds) {
      const run = this.runs.get(id);
      if (run) entries.push(toBatchEntry(run));
    }
    return { batchId, entries };
  }

  private markBatchDelivered(batchId: string, batch: BatchState): void {
    batch.sealed = true;
    batch.delivered = true;
    const idx = this.inbox.findIndex((item) => item.batchId === batchId);
    if (idx >= 0) this.inbox.splice(idx, 1);
    this.notifyWaiters();
  }

  /**
   * Explicit fetch/wait for a batch — same JSON shape as automatic injection.
   * Idempotent after delivery; marks delivered so drainInbox will not double-inject.
   */
  async getBatchResult(
    batchId: string,
    timeoutMs?: number,
  ): Promise<GetBatchResultOutcome> {
    const id = batchId.trim();
    if (!id) {
      return {
        ok: false,
        message: "batch_id must be a non-empty string.",
        returnCode: ToolReturnCode.InvalidArguments,
      };
    }

    const batch = this.batches.get(id);
    if (!batch || batch.runIds.length === 0) {
      return {
        ok: false,
        message: `Unknown batch_id: ${id}`,
        returnCode: ToolReturnCode.NotFound,
      };
    }

    // Explicit fetch seals the batch so completion can proceed even mid round.
    batch.sealed = true;

    if (!this.batchAllTerminal(batch)) {
      const waitMs =
        typeof timeoutMs === "number" &&
        Number.isFinite(timeoutMs) &&
        timeoutMs > 0
          ? Math.max(Math.floor(timeoutMs), SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS)
          : SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS;

      const parentAbort = this.input.parentSignal;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            cleanup();
            resolve();
          };
          const fail = (err: Error) => {
            cleanup();
            reject(err);
          };
          const onTick = () => {
            if (parentAbort?.aborted) {
              fail(new Error("Cancelled"));
              return;
            }
            if (this.batchAllTerminal(batch)) finish();
          };
          const onAbort = () => fail(new Error("Cancelled"));
          const cleanup = () => {
            this.waitListeners.delete(onTick);
            if (timeoutId) clearTimeout(timeoutId);
            if (parentAbort) {
              parentAbort.removeEventListener("abort", onAbort);
            }
          };

          this.waitListeners.add(onTick);
          timeoutId = setTimeout(() => {
            fail(new Error("subagent_batch_result timed out"));
          }, waitMs);
          if (parentAbort) {
            if (parentAbort.aborted) {
              fail(new Error("Cancelled"));
              return;
            }
            parentAbort.addEventListener("abort", onAbort, { once: true });
          }
          onTick();
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("timed out")) {
          return {
            ok: false,
            message: `Timed out waiting for batch_id "${id}".`,
            returnCode: ToolReturnCode.Timeout,
          };
        }
        return {
          ok: false,
          message: "Cancelled while waiting for batch results.",
          returnCode: ToolReturnCode.Cancelled,
        };
      }
    }

    if (!this.batchAllTerminal(batch)) {
      return {
        ok: false,
        message: `Timed out waiting for batch_id "${id}".`,
        returnCode: ToolReturnCode.Timeout,
      };
    }

    const result = this.buildBatchResult(id, batch);
    this.markBatchDelivered(id, batch);
    return { ok: true, result };
  }

  async waitForIncompleteBatches(signal?: AbortSignal): Promise<void> {
    const isDone = () => {
      if (signal?.aborted) return true;
      for (const [batchId, batch] of this.batches) {
        if (batch.delivered) continue;
        if (!batch.sealed || !this.batchAllTerminal(batch)) return false;
        this.maybeEnqueueBatch(batchId);
      }
      return true;
    };

    if (isDone()) return;

    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      const onTick = () => {
        if (signal?.aborted) {
          fail();
          return;
        }
        if (isDone()) finish();
      };
      const cleanup = () => {
        this.waitListeners.delete(onTick);
        if (signal) signal.removeEventListener("abort", fail);
      };

      this.waitListeners.add(onTick);
      if (signal) {
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      }
      onTick();
    });
  }

  private usedTokensFor(run: SubagentRun): number | undefined {
    const usage = run.session.contextUsage;
    const display = usage.displayUsedTokens;
    const used = usage.usedTokens;
    if (typeof display === "number" && Number.isFinite(display) && display > 0) {
      return Math.max(0, Math.round(display));
    }
    if (typeof used === "number" && Number.isFinite(used) && used > 0) {
      return Math.max(0, Math.round(used));
    }
    return undefined;
  }

  private emit(run: SubagentRun): void {
    const usedTokens = this.usedTokensFor(run);
    const event: StreamEvent = {
      type: "subagent",
      id: run.id,
      parentToolCallId: run.parentToolCallId,
      status: run.status,
      // Stream field remains `title` for renderer compat; value is the nickname.
      title: run.name,
      priority: run.priority,
      ...(run.progressText ? { progressText: run.progressText } : {}),
      ...(run.resultSummary
        ? {
            summary: parseSubagentResultPayload(run.resultSummary).result,
          }
        : {}),
      ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
    };
    this.input.onParentEvent?.(event);
  }

  /** Emit one live monitor line/tool event for a run (rides parent stream). */
  private emitLive(
    run: SubagentRun,
    live: Omit<StreamSubagentLiveEvent, "type" | "id" | "name" | "role" | "status">,
  ): void {
    const event: StreamSubagentLiveEvent = {
      type: "subagent_live",
      id: run.id,
      name: run.name,
      role: run.role,
      status: run.status,
      ...live,
    };
    this.input.onParentEvent?.(event);
  }

  /** Buffer assistant/reasoning text; throttled flush (~SUBAGENT_LIVE_TEXT_FLUSH_MS). */
  private bufferLiveText(
    run: SubagentRun,
    text: string,
    kind: "delta" | "reasoning",
  ): void {
    if (!text) return;
    let state = this.liveTextById.get(run.id);
    if (state && state.kind !== kind) {
      // Kind switch (thinking ↔ prose): flush the pending buffer first so
      // the two streams never concatenate into one monitor block.
      this.flushLiveText(run);
      state = undefined;
    }
    if (!state) {
      state = { buf: "", kind, timer: undefined };
      this.liveTextById.set(run.id, state);
    }
    state.buf = state.buf + text;
    if (state.timer === undefined) {
      state.timer = setTimeout(() => {
        if (state) state.timer = undefined;
        this.flushLiveText(run);
      }, SUBAGENT_LIVE_TEXT_FLUSH_MS);
    }
  }

  private flushLiveText(run: SubagentRun): void {
    const state = this.liveTextById.get(run.id);
    if (!state || state.buf.length === 0) return;
    const text = truncateLiveText(state.buf, SUBAGENT_LIVE_MAX_TEXT_CHARS);
    state.buf = "";
    this.emitLive(run, { kind: state.kind, text });
  }

  /** Live tool line — emitted immediately (low frequency vs deltas). */
  private emitLiveTool(
    run: SubagentRun,
    tool: { id: string; name: string; summary: string },
    finished: boolean,
  ): void {
    this.emitLive(run, {
      kind: "tool",
      tool: {
        id: tool.id,
        name: tool.name,
        summary: truncateLiveText(tool.summary, SUBAGENT_LIVE_TOOL_SUMMARY_CHARS),
        finished,
      },
    });
  }

  /** Terminal cleanup: flush pending text tail, drop run live state. */
  private cleanupLive(run: SubagentRun): void {
    this.flushLiveText(run);
    const state = this.liveTextById.get(run.id);
    if (state && state.timer !== undefined) clearTimeout(state.timer);
    this.liveTextById.delete(run.id);
    this.liveToolsByRunId.delete(run.id);
  }

  private persistRun(run: SubagentRun): void {
    const db = this.input.db;
    if (!db) return;
    try {
      upsertSubagentRun(db, toRunRecord(run));
    } catch (err) {
      agentLogWarn("subagent.persist.run_failed", {
        parentSessionId: this.parentSessionId,
        subagentId: run.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persistMessages(run: SubagentRun): void {
    const db = this.input.db;
    if (!db) return;
    try {
      replaceSubagentMessages(db, run.id, run.session.messages);
    } catch (err) {
      agentLogWarn("subagent.persist.messages_failed", {
        parentSessionId: this.parentSessionId,
        subagentId: run.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private flushAllPersistence(): void {
    for (const run of this.runs.values()) {
      this.persistRun(run);
      this.persistMessages(run);
    }
  }

  private settleDone(run: SubagentRun): void {
    const resolve = this.resolveDoneById.get(run.id);
    if (resolve) {
      this.resolveDoneById.delete(run.id);
      resolve();
    }
  }

  private pickNextQueued(): SubagentRun | null {
    const queued: SubagentRun[] = [];
    for (const run of this.runs.values()) {
      if (run.status === "queued") queued.push(run);
    }
    if (queued.length === 0) return null;
    queued.sort(
      (a, b) => b.priority - a.priority || a.createdAt - b.createdAt,
    );
    return queued[0] ?? null;
  }

  /** Promote queued runs into free concurrent slots (priority DESC, then FIFO). */
  private pumpQueue(): void {
    while (this.activeRunningCount() < MAX_CONCURRENT_SUBAGENTS) {
      const next = this.pickNextQueued();
      if (!next) break;
      this.startRun(next);
    }
  }

  private cancelQueued(run: SubagentRun): void {
    if (run.status !== "queued") return;
    run.status = "cancelled";
    run.progressText = "Cancelled";
    run.errorMessage = "Cancelled";
    run.updatedAt = Date.now();
    this.emit(run);
    this.persistRun(run);
    this.settleDone(run);
    this.maybeEnqueueBatch(run.batchId);
    this.notifyWaiters();
    this.pumpQueue();
  }

  private startRun(run: SubagentRun): void {
    if (this.startedIds.has(run.id)) return;
    if (isTerminal(run.status)) return;
    if (run.abort.signal.aborted || this.input.parentSignal?.aborted) {
      run.status = "cancelled";
      run.progressText = "Cancelled";
      run.errorMessage = "Cancelled";
      run.updatedAt = Date.now();
      this.emit(run);
      this.persistRun(run);
      this.settleDone(run);
      this.maybeEnqueueBatch(run.batchId);
      this.notifyWaiters();
      this.pumpQueue();
      return;
    }

    this.startedIds.add(run.id);
    run.status = "running";
    run.progressText = "Starting…";
    run.updatedAt = Date.now();
    this.emit(run);
    this.persistRun(run);

    const unlimitedTurnBudgets = this.input.unlimitedTurnBudgets === true;
    const budgetFields: Pick<
      RunAgentTurnInput,
      "unlimitedTurnBudgets" | "maxModelIterations" | "maxTurnTokens"
    > = unlimitedTurnBudgets
      ? { unlimitedTurnBudgets: true }
      : {
          maxModelIterations: Math.min(
            this.input.maxModelIterations ?? MAX_SUBAGENT_MODEL_ITERATIONS,
            MAX_SUBAGENT_MODEL_ITERATIONS,
          ),
          ...(this.input.maxTurnTokens !== undefined
            ? { maxTurnTokens: this.input.maxTurnTokens }
            : {}),
        };
    const childSession = run.session;
    const abort = run.abort;
    const id = run.id;
    const batchId = run.batchId;
    const role = run.role;
    const prompt = run.prompt;

    void (async () => {
      try {
        const result = await this.input.runTurn({
          session: childSession,
          userText: prompt,
          client: this.input.client,
          gate: this.input.gate,
          createId: this.input.createId,
          signal: abort.signal,
          ...(this.input.db ? { checkpoint: () => {
            // Tool execution must stop if this durable boundary cannot commit.
            // The normal UI persistence helpers intentionally swallow errors.
            upsertSubagentRun(this.input.db!, toRunRecord(run));
            replaceSubagentMessages(this.input.db!, run.id, childSession.messages);
          } } : {}),
          ...budgetFields,
          ...(this.input.contextLimitTokens !== undefined
            ? { contextLimitTokens: this.input.contextLimitTokens }
            : {}),
          ...(this.input.compactTriggerRatio !== undefined
            ? { compactTriggerRatio: this.input.compactTriggerRatio }
            : {}),
          ...(this.input.iterationProtectRawIterationCount !== undefined
            ? {
                iterationProtectRawIterationCount:
                  this.input.iterationProtectRawIterationCount,
              }
            : {}),
          ...(this.input.iterationProtectTokenRatio !== undefined
            ? { iterationProtectTokenRatio: this.input.iterationProtectTokenRatio }
            : {}),
          agentSystemPrompt:
            typeof this.input.subagentSystemPrompt === "string" &&
            this.input.subagentSystemPrompt.trim()
              ? this.input.subagentSystemPrompt
              : getDefaultSubagentSystemPrompt(),
          ...(this.input.environmentContext
            ? { environmentContext: this.input.environmentContext }
            : {}),
          ...(this.input.getVisionClient
            ? { getVisionClient: this.input.getVisionClient }
            : {}),
          ...(this.input.getImageGenClient
            ? { getImageGenClient: this.input.getImageGenClient }
            : {}),
          ...(this.input.uploadImageGenInput
            ? { uploadImageGenInput: this.input.uploadImageGenInput }
            : {}),
          ...(this.input.hooks ? { hooks: this.input.hooks } : {}),
          ...(this.input.streamChat
            ? { streamChat: this.input.streamChat }
            : {}),
          ...(this.input.summarize ? { summarize: this.input.summarize } : {}),
          isSubagentTurn: true,
          parentSessionId: this.parentSessionId,
          subagentId: id,
          subagentRoleKind: role,
          toolPredicate: subagentToolPredicate(role),
          extraSystemPrompt: buildSubagentSystemPrompt(role),
          ...(this.input.llmBundle
            ? { llmBundle: this.input.llmBundle }
            : {}),
          ...(this.input.listAgentSessions
            ? { listAgentSessions: this.input.listAgentSessions }
            : {}),
          ...(this.input.listSessionHistory
            ? { listSessionHistory: this.input.listSessionHistory }
            : {}),
          ...(this.input.listWorkspaces
            ? { listWorkspaces: this.input.listWorkspaces }
            : {}),
          ...(this.input.fsmGraphLibrary
            ? { fsmGraphLibrary: this.input.fsmGraphLibrary }
            : {}),
          ...(this.input.loops ? { loops: this.input.loops } : {}),
          onEvent: (event) => {
            if (event.type === "progress" && typeof event.text === "string") {
              run.progressText = event.text;
              run.updatedAt = Date.now();
              this.emit(run);
            } else if (event.type === "status") {
              // Only mirror in-progress statuses. Terminal idle/error/cancelled
              // are applied after runTurn returns — avoid a trailing "running"
              // emit that can race the completion update in the UI.
              if (
                event.status === "running" ||
                event.status === "streaming" ||
                event.status === "tool_running"
              ) {
                run.status = "running";
                run.updatedAt = Date.now();
                this.emit(run);
              }
            } else if (
              event.type === "usage" ||
              event.type === "context_display"
            ) {
              run.updatedAt = Date.now();
              this.emit(run);
            } else if (event.type === "text_delta") {
              // Live monitor only — buffered, throttled flush; never lands in
              // session.messages or the parent transcript.
              this.bufferLiveText(run, event.text, "delta");
            } else if (event.type === "reasoning_delta") {
              // Live monitor only — thinking text rides the same channel
              // (kind-separated buffering); never lands in session.messages.
              this.bufferLiveText(run, event.text, "reasoning");
            } else if (event.type === "tool_call") {
              const tool = {
                id: event.id,
                name: event.name,
                summary: summarizeToolArguments(event.arguments),
              };
              let tools = this.liveToolsByRunId.get(run.id);
              if (!tools) {
                tools = new Map();
                this.liveToolsByRunId.set(run.id, tools);
              }
              tools.set(event.id, tool);
              this.emitLiveTool(run, tool, false);
            } else if (event.type === "tool_finished") {
              const tool = this.liveToolsByRunId
                .get(run.id)
                ?.get(event.id);
              if (tool) {
                this.emitLiveTool(run, tool, true);
              } else {
                // Unknown/missed tool_call (e.g. renderer opened mid-run):
                // still surface the finish flip with what we know.
                this.emitLiveTool(
                  run,
                  { id: event.id, name: "", summary: "" },
                  true,
                );
              }
            }
            // reasoning_delta is forwarded live above (overlay-only view;
            // the main transcript keeps its Thinking-card convention).
          },
        });

        run.updatedAt = Date.now();
        if (result.status === "cancelled" || abort.signal.aborted) {
          run.status = "cancelled";
          run.progressText = "Cancelled";
          run.errorMessage = "Cancelled";
        } else if (result.status === "error") {
          run.status = "error";
          run.progressText = childSession.progressText || "Error";
          run.errorMessage =
            childSession.progressText.trim() || "Subagent error";
          run.resultSummary = extractSubagentResult(childSession).summaryJson;
        } else {
          run.status = "completed";
          run.progressText = "";
          run.resultSummary = extractSubagentResult(childSession).summaryJson;
        }
        this.emit(run);
        agentLogInfo("subagent.end", {
          parentSessionId: this.parentSessionId,
          subagentId: id,
          batchId,
          status: run.status,
          modelIterations: result.modelIterations,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run.status = abort.signal.aborted ? "cancelled" : "error";
        run.progressText = message;
        run.errorMessage = message;
        run.updatedAt = Date.now();
        this.emit(run);
        agentLogWarn("subagent.exception", {
          parentSessionId: this.parentSessionId,
          subagentId: id,
          message,
        });
      } finally {
        this.persistRun(run);
        this.persistMessages(run);
        this.settleDone(run);
        this.cleanupLive(run);
        this.maybeEnqueueBatch(batchId);
        this.notifyWaiters();
        this.pumpQueue();
      }
    })();
  }

  dispatch(args: DispatchSubagentInput): DispatchSubagentResult {
    const prompt = args.prompt.trim();
    if (!prompt) {
      return {
        ok: false,
        message: "prompt is required",
        returnCode: ToolReturnCode.InvalidArguments,
      };
    }
    const batchId = args.batchId.trim();
    if (!batchId) {
      return {
        ok: false,
        message: "batch_id is required",
        returnCode: ToolReturnCode.InvalidArguments,
      };
    }
    const parentToolCallId = args.parentToolCallId.trim();
    if (!parentToolCallId) {
      return {
        ok: false,
        message: "Internal error: missing tool call id for dispatch_subagent.",
        returnCode: ToolReturnCode.GenericFailure,
      };
    }
    if (this.input.parentSignal?.aborted) {
      return {
        ok: false,
        message: "Parent turn was cancelled.",
        returnCode: ToolReturnCode.Cancelled,
      };
    }

    const existingBatch = this.batches.get(batchId);
    if (existingBatch && (existingBatch.delivered || existingBatch.sealed)) {
      return {
        ok: false,
        message: `batch_id "${batchId}" is already sealed or delivered this turn; use a new batch_id.`,
        returnCode: ToolReturnCode.InvalidArguments,
      };
    }

    if (this.createdThisTurn >= MAX_SUBAGENTS_PER_TURN) {
      return {
        ok: false,
        message: `Subagent limit reached for this turn (${MAX_SUBAGENTS_PER_TURN}). Await or stop existing runs first.`,
        returnCode: ToolReturnCode.GenericFailure,
      };
    }

    const role = normalizeSubagentRole(args.role);
    const priority = normalizeSubagentPriority(args.priority);
    const name =
      normalizeSubagentName(args.name) ?? nameFromPrompt(prompt);
    const id = `sa_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    const parent = this.input.parentSession;
    const abort = new AbortController();
    const startImmediately =
      this.activeRunningCount() < MAX_CONCURRENT_SUBAGENTS;

    if (this.input.parentSignal) {
      if (this.input.parentSignal.aborted) {
        abort.abort();
      } else {
        this.input.parentSignal.addEventListener(
          "abort",
          () => {
            const live = this.runs.get(id);
            if (!live) return;
            if (live.status === "queued") {
              this.cancelQueued(live);
            } else {
              live.abort.abort();
            }
          },
          { once: true },
        );
      }
    }

    const childSession: Session = {
      id: randomUUID(),
      type: "agent",
      title: name,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      progressText: "",
      messages: [],
      model: parent.model,
      providerId: parent.providerId,
      workspaceId: parent.workspaceId,
      workspacePath: parent.workspacePath,
      pinned: false,
      archived: false,
      archivedAt: null,
      contextUsage: { usedTokens: 0 },
      plan: null,
    };

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.resolveDoneById.set(id, resolveDone);

    const run: SubagentRun = {
      id,
      parentSessionId: this.parentSessionId,
      parentToolCallId,
      batchId,
      name,
      prompt,
      role,
      priority,
      status: startImmediately ? "running" : "queued",
      progressText: startImmediately ? "Starting…" : "Queued",
      createdAt: now,
      updatedAt: now,
      abort,
      session: childSession,
      done,
    };
    this.runs.set(id, run);

    if (existingBatch) {
      existingBatch.runIds.push(id);
    } else {
      this.batches.set(batchId, {
        runIds: [id],
        sealed: false,
        delivered: false,
      });
    }

    this.createdThisTurn += 1;
    this.emit(run);
    this.persistRun(run);

    agentLogInfo("subagent.dispatch", {
      parentSessionId: this.parentSessionId,
      subagentId: id,
      batchId,
      name,
      role,
      priority,
      status: run.status,
      parentToolCallId,
    });

    if (startImmediately) {
      this.startRun(run);
    }

    return {
      ok: true,
      id,
      name,
      batchId,
      priority,
      status: startImmediately ? "running" : "queued",
    };
  }

  async awaitRuns(
    ids: string[],
    timeoutMs?: number,
  ): Promise<AwaitSubagentEntry[]> {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    const waiters: Array<Promise<void>> = [];
    for (const id of unique) {
      const run = this.runs.get(id);
      if (run) waiters.push(run.done);
    }

    if (waiters.length === 0) {
      return unique.map((id) => ({
        id,
        name: id,
        priority: 0,
        status: "error" as const,
        errorMessage: "Unknown subagent id",
      }));
    }

    const parentAbort = this.input.parentSignal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          reject(err);
        };

        void Promise.all(waiters).then(finish, fail);

        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            fail(new Error("await_subagent timed out"));
          }, timeoutMs);
        }
        if (parentAbort) {
          if (parentAbort.aborted) {
            fail(new Error("Cancelled"));
            return;
          }
          onAbort = () => fail(new Error("Cancelled"));
          parentAbort.addEventListener("abort", onAbort, { once: true });
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("timed out")) {
        for (const id of unique) {
          const run = this.runs.get(id);
          if (!run) continue;
          if (run.status === "queued") {
            this.cancelQueued(run);
          } else if (run.status === "running") {
            run.abort.abort();
          }
        }
        await Promise.race([
          Promise.all(waiters),
          new Promise<void>((r) => setTimeout(r, 500)),
        ]);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (onAbort && parentAbort) {
        parentAbort.removeEventListener("abort", onAbort);
      }
    }

    const entries = unique.map((id) => {
      const run = this.runs.get(id);
      if (!run) {
        return {
          id,
          name: id,
          priority: 0,
          status: "error" as const,
          errorMessage: "Unknown subagent id",
        };
      }
      const entry: AwaitSubagentEntry = {
        id: run.id,
        name: run.name,
        priority: run.priority,
        status: run.status,
      };
      if (run.resultSummary) entry.summary = run.resultSummary;
      if (run.errorMessage) entry.errorMessage = run.errorMessage;
      return entry;
    });

    // If await covered an entire sealed batch, mark delivered to avoid double inject.
    const awaited = new Set(unique);
    for (const [batchId, batch] of this.batches) {
      if (batch.delivered) continue;
      if (!batch.runIds.every((id) => awaited.has(id))) continue;
      if (!this.batchAllTerminal(batch)) continue;
      batch.sealed = true;
      batch.delivered = true;
      const idx = this.inbox.findIndex((item) => item.batchId === batchId);
      if (idx >= 0) this.inbox.splice(idx, 1);
    }

    return entries;
  }

  stop(ids: string[]): StopSubagentEntry[] {
    return ids.map((raw) => {
      const id = raw.trim();
      const run = this.runs.get(id);
      if (!run) {
        return {
          id,
          name: id,
          status: "error" as const,
          stopped: false,
          message: "Unknown subagent id",
        };
      }
      if (run.status === "queued") {
        this.cancelQueued(run);
        return {
          id: run.id,
          name: run.name,
          status: "cancelled",
          stopped: true,
          message: "Cancelled while queued",
        };
      }
      if (run.status !== "running") {
        return {
          id: run.id,
          name: run.name,
          status: run.status,
          stopped: false,
          message: `Subagent already ${run.status}`,
        };
      }
      run.abort.abort();
      return {
        id: run.id,
        name: run.name,
        status: "cancelled",
        stopped: true,
        message: "Stop signalled",
      };
    });
  }

  stopAll(): void {
    for (const run of [...this.runs.values()]) {
      if (run.status === "queued") {
        this.cancelQueued(run);
      } else if (run.status === "running") {
        run.abort.abort();
      }
    }
  }
}

export function createSubagentManager(
  input: CreateSubagentManagerInput,
): SubagentManager {
  const existing = managersByParentSession.get(input.parentSession.id);
  existing?.dispose();
  return new SubagentManager(input);
}
