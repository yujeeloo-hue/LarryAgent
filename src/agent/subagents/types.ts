import type { Session } from "../../session/types.js";

export type SubagentRole = "general" | "explore" | "worker";

export type SubagentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export type SubagentRun = {
  id: string;
  parentSessionId: string;
  parentToolCallId: string;
  /** Join group id from dispatch_subagent. */
  batchId: string;
  /** Optional LLM-assigned nickname for human-friendly UI (ids remain the handle). */
  name: string;
  prompt: string;
  role: SubagentRole;
  /** 0–100; higher starts sooner when queued. */
  priority: number;
  status: SubagentRunStatus;
  progressText: string;
  createdAt: number;
  updatedAt: number;
  abort: AbortController;
  session: Session;
  /** Compact JSON `{ result, attachment, table }` for the parent LLM. */
  resultSummary?: string;
  errorMessage?: string;
  /** Settles when the child turn finishes (any terminal status). */
  done: Promise<void>;
};

export type SubagentStatusSnapshot = {
  id: string;
  batchId: string;
  name: string;
  role: SubagentRole;
  priority: number;
  status: SubagentRunStatus;
  progressText: string;
  parentToolCallId: string;
  summary?: string;
  errorMessage?: string;
};

/**
 * Full-fidelity transcript view of a run — raw `Message[]` (not the projected
 * role/text detail). Consumed by the Subagents window, which re-renders it
 * through the main conversation pipeline.
 */
export type SubagentTranscript = {
  run: SubagentStatusSnapshot & { createdAt: number; updatedAt: number };
  messages: Session["messages"];
};

/** Subagents-window list item: status snapshot + ordering timestamps. */
export type SubagentRunSummary = SubagentStatusSnapshot & {
  createdAt: number;
  updatedAt: number;
};

export type SubagentTranscriptMessage = {
  role: string;
  text: string;
};

export type SubagentDetailSnapshot = SubagentStatusSnapshot & {
  prompt: string;
  messages: SubagentTranscriptMessage[];
};

export type DispatchSubagentInput = {
  prompt: string;
  /** Required join group id; same id = one batch. */
  batchId: string;
  /** Optional short nickname for UI / logs (await/stop still use id). */
  name?: string;
  role?: SubagentRole;
  /** 0–100; higher starts sooner when concurrent slots are full. Default 50. */
  priority?: number;
  parentToolCallId: string;
};

export type DispatchSubagentResult =
  | {
      ok: true;
      id: string;
      name: string;
      batchId: string;
      priority: number;
      status: "queued" | "running";
    }
  | {
      ok: false;
      message: string;
      returnCode: number;
    };

export type AwaitSubagentEntry = {
  id: string;
  name: string;
  priority: number;
  status: SubagentRunStatus;
  summary?: string;
  errorMessage?: string;
};

export type StopSubagentEntry = {
  id: string;
  name: string;
  status: SubagentRunStatus;
  stopped: boolean;
  message: string;
};

export type SubagentBatchEntry = {
  id: string;
  name: string;
  priority: number;
  status: SubagentRunStatus;
  summary?: string;
  errorMessage?: string;
};

/** Completed batch ready for parent transcript injection. */
export type SubagentBatchResult = {
  batchId: string;
  entries: SubagentBatchEntry[];
};

export type GetBatchResultOutcome =
  | { ok: true; result: SubagentBatchResult }
  | { ok: false; message: string; returnCode: number };

/** Injected into tool execute context for parent turns. */
export type SubagentHost = {
  dispatch: (input: DispatchSubagentInput) => DispatchSubagentResult;
  awaitRuns: (
    ids: string[],
    timeoutMs?: number,
  ) => Promise<AwaitSubagentEntry[]>;
  /**
   * Wait for a batch to finish and return the same payload shape as automatic
   * `subagent_batch_result` injection. Marks the batch delivered (no double inject).
   */
  getBatchResult: (
    batchId: string,
    timeoutMs?: number,
  ) => Promise<GetBatchResultOutcome>;
  getStatus: (ids?: string[]) => SubagentStatusSnapshot[];
  list: (includeFinished?: boolean) => SubagentStatusSnapshot[];
  stop: (ids: string[]) => StopSubagentEntry[];
  stopAll: () => void;
  getDetail: (id: string) => SubagentDetailSnapshot | null;
  /** After a parent tool iteration: seal open batches so completion can deliver. */
  sealOpenBatches: () => void;
  hasIncompleteBatches: () => boolean;
  waitForIncompleteBatches: (signal?: AbortSignal) => Promise<void>;
  drainInbox: () => SubagentBatchResult[];
};
