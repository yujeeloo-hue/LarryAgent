/**
 * TurnHost — capability surface for agent turns (no control-flow loop).
 *
 * Graph NodeActions call these methods; Session/Transcript stay authoritative
 * and are mutated only through Host.
 *
 * Dependency rule: this package must NOT import `../workflow/`, `../fsm/`,
 * `../roles/`, `../domain/`, or `../policy/`.
 */

import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  OpenAiChatMessage,
  OpenAiCompatibleClientConfig,
  OpenAiToolDefinition,
} from "../../llm/types.js";
import type { AttachmentDraft, PendingSteer } from "../ipcTypes.js";
import type {
  AssistantMessage,
  Session,
  SessionStatus,
  TextPart,
  ToolCallPart,
} from "../../session/types.js";
import type { PermissionGateState } from "../../tools/types.js";
import type { SessionPatch } from "../contracts/index.js";
import type {
  DesktopNotifyInput,
  FsmRunShellInput,
  FsmRunShellResult,
  RunAgentTurnResult,
  StreamChatFn,
  SummarizeFn,
} from "../types.js";

/** Same shape as RunAgentTurnResult — Host-local name avoids workflow imports. */
export type TurnRunResult = RunAgentTurnResult;

/** Wire LLM used for one model round. */
export type TurnStreamLlm = {
  client: OpenAiCompatibleClientConfig;
  stream: StreamChatFn;
};

export type TurnStartOptions = {
  userText: string;
  attachments?: AttachmentDraft[];
  /** Retry-click continuation: stamp the user message UI-hidden (see turnContinuations.ts). */
  continuation?: "retry";
  suppressUserMessage?: boolean;
  resumeToolBatch?: {
    assistantMessageId: string;
    toolCallIds: string[];
  };
  parentSessionId?: string;
  subagentId?: string;
};

export type PrepareToolsInput = {
  /** Optional allow/deny filter (AND'd with offer set when enabled). */
  toolPredicate?: (name: string) => boolean;
  /**
   * Intersect with Hot/offer baseline (includes forced meta tools).
   * Default: true for parent turns, false for subagent turns.
   */
  useOfferSet?: boolean;
};

export type PrepareToolsResult = {
  tools: OpenAiToolDefinition[];
};

export type PrepareModelWindowInput = {
  /** Scope of the model binding that will consume this window. */
  reasoningScope?: string;
  /** Explicit label for a caller-selected persona template. */
  personaLabel?: string;
  /** SUBAGENT.md / test override; omitted → default AGENT.md / SUBAGENT.md by persona slot. */
  agentTemplateOverride?: string;
  /**
   * Caller-selected prompt blocks as an extra Bucket0 system message
   * after the base persona.
   */
  roleSystemPrompt?: string;
  /** Caller-assembled overlay text (wire-only trailing user message). */
  trailingOverlay?: string;
  /** Do not run Cold/Warm LLM compaction for this round (hook deny still wins). */
  skipCompact?: boolean;
  /** Do not hard-truncate the conversation suffix when still over the trigger. */
  skipHardTruncate?: boolean;
  tools: OpenAiToolDefinition[];
  hostedTools?: import("../../session/types.js").JsonObject[];
  progressLabel?: string;
};

export type PrepareModelWindowOk = {
  ok: true;
  reasoningScope?: string;
  messages: OpenAiChatMessage[];
  estimatedTokens: number;
  compacted: boolean;
};

export type PrepareModelWindowResult =
  | PrepareModelWindowOk
  | { ok: false; result: TurnRunResult };

export type ModelRoundResult =
  | {
      kind: "ok";
      assistant: AssistantMessage;
      toolCalls: ToolCallPart[];
      textPart?: TextPart;
      reasoningBuf: string;
      roundBillableTokens: number;
    }
  | {
      /**
       * User-prompt interrupt (non-terminal): the stream was aborted by the
       * one-shot interrupt signal. Partial text/reasoning are sealed onto
       * the assistant (text suffixed "(interrupted)"), complete tool calls
       * carry Cancelled results, and the caller loops back to the round
       * gate — the queued prompt drains before the next model call.
       */
      kind: "interrupted";
      assistant: AssistantMessage;
      reasoningBuf: string;
      roundBillableTokens: number;
      sealedToolCalls: number;
    }
  | { kind: "cancelled"; result: TurnRunResult }
  | { kind: "error"; result: TurnRunResult };

export type ToolsPhaseResult =
  | {
      kind: "ok";
      cancelled: false;
      toolFailureCount: number;
      /** Successful tools' route events this batch (EmitRouteEvent last-wins). */
      routeEvents?: import("../contracts/index.js").RouteEventPatch[];
      /** Executed handler results this batch (call order, optional structured receipt). */
      receipts?: import("../runTools.js").ToolCallReceipt[];
    }
  | { kind: "cancelled"; result: TurnRunResult }
  | { kind: "error"; result: TurnRunResult };

export type AwaitSubagentResult =
  | "injected"
  | "none"
  | "cancelled";

export type TurnHostCounters = {
  modelIterations: number;
  turnBillableTokens: number;
  /** Cumulative tool results with returnCode !== 0 this Turn. */
  toolFailureCount: number;
};

/**
 * Capability-only construction bag. Intentionally excludes composer/graph
 * fields (`runMode`, `controlIntent`, plan attempt knobs, etc.).
 */
export type CreateTurnHostConfig = {
  session: Session;
  client: OpenAiCompatibleClientConfig;
  gate: PermissionGateState;
  createId: () => string;
  signal?: AbortSignal;
  /**
   * Holder the host fills at construction with its one-shot interrupt
   * trigger (same semantics as `TurnHost.requestInterrupt`); the main
   * process fires it from prompt enqueue without reaching into the host
   * object.
   */
  interruptPort?: { fire: (() => boolean) | null };
  onEvent?: (event: StreamEvent) => void;
  /** Strict durable tool boundary; failures halt instead of retrying actions. */
  checkpoint?: () => void | Promise<void>;
  /** Desktop notification sink (appNotify toast/popup); main-process only. */
  desktopNotify?: (input: DesktopNotifyInput) => void;
  /**
   * Composer run-mode switch request sink (`NodeActionSetComposerRunMode`);
   * main-process only. Recorded, applied in the turn `finally`; never throws.
   */
  requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
  /**
   * FSM NodeAction shell-execution sink (`NodeActionRunShell`); main process
   * only. Never throws — failures come back as `status: "error"`.
   */
  runShell?: (input: FsmRunShellInput) => Promise<FsmRunShellResult>;
  /**
   * FSM session blackboard accessors (`NodeActionWriteBlackboard` /
   * `NodeActionReadBlackboard` / `NodeActionCompare`); main process
   * only. `blackboardSet` returns a named error on the 64KB cap.
   */
  blackboardGet?: (key: string) => unknown;
  blackboardSet?: (
    key: string,
    value: unknown,
  ) => { ok: true } | { ok: false; error: string };
  hooks?: import("../../hooks/types.js").HookRunner;
  unlimitedTurnBudgets?: boolean;
  maxModelIterations?: number;
  maxTurnTokens?: number;
  isSubagentTurn?: boolean;
  contextLimitTokens?: number;
  compactTriggerRatio?: number;
  iterationProtectRawIterationCount?: number;
  iterationProtectTokenRatio?: number;
  /**
   * When true, S3-uploaded image attachments render as multimodal
   * `image_url` content parts on the model wire. Inherited by subagent
   * turns only when explicitly forwarded (subagents keep the stub path).
   */
  imageUrls?: boolean;
  /** See RunAgentTurnInput.toolRoleImages — wire-side tool image parts. */
  toolRoleImages?: boolean;
  /** See RunAgentTurnInput.uploadReadImage — read_image direct upload. */
  uploadReadImage?: (input: {
    imagePath: string;
    mimeType: string;
  }) => Promise<{ url: string; key: string } | null>;
  environmentContext?: {
    flags: import("../../settings/types.js").EnvironmentContextFlags;
    workspace: import("../environmentContext.js").EnvironmentWorkspaceSnapshot;
    locale: import("../environmentContext.js").EnvironmentLocaleSnapshot;
  };
  getVisionClient?: () => Promise<
    import("../../tools/types.js").VisionClientConfig | null
  >;
  getImageGenClient?: () => Promise<
    import("../../tools/types.js").ImageGenClientConfig | null
  >;
  uploadImageGenInput?: (
    bytes: Uint8Array,
    mimeType: string,
    ext: string,
  ) => Promise<string>;
  streamChat?: StreamChatFn;
  summarize?: SummarizeFn;
  sessionDb?: import("../../session/db/openDb.js").SessionDatabase;
  /** Optional LLM bundle forwarded to nested subagent turns (defaults to session client). */
  llmBundle?: import("../roles/types.js").RoleLlmBundle;
  /** Optional turn-wide tools[] filter (e.g. subagent child turns). */
  toolPredicate?: (name: string) => boolean;
  additionalTools?: import("../../tools/types.js").RegisteredTool[];
  takePendingSteer?: () => PendingSteer[];
  hasPendingSteer?: () => boolean;
  /** Consume a queued /pause request (parent turns only; see enforceBudget). */
  takePauseRequested?: () => boolean;
  extraSystemPrompt?: string;
  resolvePersona?: () => import("./buildSystemPrefix.js").PersonaOverride;
  wireTrailingNote?: string;
  conversationTurnLimit?: number;
  parentSessionId?: string;
  subagentId?: string;
  subagentRoleKind?: import("../subagents/types.js").SubagentRole;
  listAgentSessions?: () => Session[];
  /** Summarized session_history records (search_session_history scope). */
  listSessionHistory?: () => import("../../session/db/sessionHistoryRepository.js").SessionHistoryRecord[];
  /** Known workspaces (id + name) for search_session_history scoping. */
  listWorkspaces?: () => { id: string; name: string }[];
  /** Graph library port forwarded to the fsm_graph tool (main process only). */
  fsmGraphLibrary?: import("../../tools/fsmGraphTool.js").FsmGraphLibraryPort;
  /** Turn-handoff port for the turn_handoff tool (main process only). */
  turnHandoff?: import("../../tools/turnHandoffTool.js").TurnHandoffPort;
  /** Loops service port for the loops tool (main process only). */
  loops?: import("../../tools/loopsTool.js").LoopsToolPort;
  /** Notification hub port for the notify tool (main process only). */
  notify?: import("../../tools/notifyTool.js").NotifyToolPort;
};

/**
 * Capability-only API. Control flow (while-loop / graph) lives in
 * `TurnWorkflow` implementations under `../workflow/`.
 */
export interface TurnHost {
  readonly session: Session;
  readonly gate: PermissionGateState;
  readonly createId: () => string;
  readonly signal?: AbortSignal;
  /**
   * Fire the one-shot user-prompt interrupt: aborts the in-flight model
   * stream without ending the turn. The round seals partial content and
   * returns kind:"interrupted"; the round gate drains the queued prompt
   * before the next model call. Returns false when already fired or
   * consumed by a drain.
   */
  requestInterrupt(): boolean;
  readonly onEvent?: (event: StreamEvent) => void;
  /** Desktop notification sink (appNotify toast/popup); main-process only. */
  readonly desktopNotify?: (input: DesktopNotifyInput) => void;
  /** Composer run-mode switch request sink; main-process only. */
  readonly requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
  /**
   * FSM NodeAction shell-execution sink (`NodeActionRunShell`); main process
   * only. Never throws — failures come back as `status: "error"`.
   */
  readonly runShell?: (input: FsmRunShellInput) => Promise<FsmRunShellResult>;
  /** FSM session blackboard accessors; main process only. */
  readonly blackboardGet?: (key: string) => unknown;
  readonly blackboardSet?: (
    key: string,
    value: unknown,
  ) => { ok: true } | { ok: false; error: string };
  readonly isSubagentTurn: boolean;

  getCounters(): TurnHostCounters;
  setCounters(next: Partial<TurnHostCounters>): void;
  /** Reset iteration/token budgets (caller decides when, e.g. plan step progress). */
  resetTurnBudgets(reason: string): void;
  /** Generic session projection write (plan / planDoc / phase). */
  applySessionPatch(patch: SessionPatch): void;
  /** Whether a plan document file exists on disk. */
  planDocExists(path: string): boolean;
  readPlanDocContent?(path: string): Promise<string | null>;
  adoptPlanDoc?(path: string, executionRequested: boolean): Promise<import("../../session/types.js").SessionPlanDoc | null>;
  /** Best-effort delete of a plan document file on disk. */
  deletePlanDoc(path: string): void;

  /** Turn prologue — hooks, append user message, display ring init. */
  startTurn(input: TurnStartOptions): Promise<"ok" | TurnRunResult>;

  checkAbort(): boolean;
  /** Returns resume | terminal result when Continue/Stop resolves. */
  enforceBudget(): Promise<"resume" | TurnRunResult>;
  /**
   * Append the latest user correction, if any, without starting a new Turn.
   * Returns true when a pending slot was consumed (including hook denial).
   */
  drainPendingSteer(): Promise<boolean>;
  hasPendingSteer(): boolean;

  /**
   * Assemble this iteration's tools[] (predicate / offer set).
   * Call before {@link prepareModelWindow}; a later action may record
   * execution-time denies without changing the offered tools[].
   */
  prepareTools(input?: PrepareToolsInput): PrepareToolsResult;

  /**
   * Compact + build model-facing messages + hard-truncate.
   * Requires `tools` for token estimates. Does not assemble or return tools.
   * Does not push an assistant shell (caller / streamModelRound does).
   */
  prepareModelWindow(
    input: PrepareModelWindowInput,
  ): Promise<PrepareModelWindowResult>;

  streamModelRound(input: {
    llm: TurnStreamLlm;
    messages: OpenAiChatMessage[];
    tools: OpenAiToolDefinition[];
    /** Scope stamped when the window was built. Host drops foreign echo fields. */
    builtScope?: string;
    hostedTools?: import("../../session/types.js").JsonObject[];
    progressText: string;
  }): Promise<ModelRoundResult>;

  runToolsPhase(
    assistant: AssistantMessage,
    toolCalls: ToolCallPart[],
    options?: {
      disabledTools?: string[];
      allowedTools?: string[];
      extra?: Record<string, unknown>;
    },
  ): Promise<ToolsPhaseResult>;

  /**
   * Append an assistant message carrying runtime-authored tool calls (no model
   * request) and announce them on the stream so the UI renders their cards.
   * The caller then executes them via {@link runToolsPhase}.
   */
  appendSyntheticToolRound(input: {
    toolCalls: ToolCallPart[];
    progressText?: string;
  }): AssistantMessage;

  /**
   * Seal open batches; optionally wait for incomplete; drain + inject.
   * `waitIfIncomplete` matches the no-tool idle path.
   */
  awaitSubagentBatches(options?: {
    waitIfIncomplete?: boolean;
  }): Promise<AwaitSubagentResult>;

  dropMessage(id: string): void;
  /** Idle path: surface reasoning-only or drop blank assistant. */
  finalizeEmptyAssistant(input: {
    assistant: AssistantMessage;
    textPart?: TextPart;
    reasoningBuf: string;
  }): void;

  finish(
    status: SessionStatus,
    progressText: string,
    doneReason: "completed" | "cancelled" | "paused" | "error",
    iterations?: number,
  ): Promise<TurnRunResult>;

  emitProgress(text: string): void;
  emitError(message: string): void;
  touchSession(progressText?: string): void;

  dispose(): void;
}
