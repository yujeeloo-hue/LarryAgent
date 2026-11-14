import type { JsonObject, SessionStatus } from "../session/types.js";

export type ProviderRequestSafety = "read_only" | "effects_possible";

/**
 * Stream events from the llm/adapter toward agent turn / UI.
 */

export type StreamTextDeltaEvent = {
  type: "text_delta";
  text: string;
  messageId?: string;
};

/** Provider reasoning / CoT deltas (e.g. Qwen `reasoning_content`). */
export type StreamReasoningDeltaEvent = {
  type: "reasoning_delta";
  text: string;
  messageId?: string;
};

export type StreamHostedToolEvent = {
  type: "hosted_tool";
  id: string;
  name: string;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  item?: JsonObject;
  messageId?: string;
};

export type StreamResponseStateEvent = {
  type: "response_state";
  responseId: string;
  status: string;
  output?: JsonObject[];
  stored?: boolean;
  /** Internal snapshot of the capabilities offered by this exact HTTP request. */
  requestSafety?: ProviderRequestSafety;
  /** Internal: this submitted request was rejected for its missing/expired cursor. */
  rejectedPreviousResponseId?: string;
  /** Internal: this submitted request explicitly rejected store:true. */
  rejectedStore?: boolean;
  messageId?: string;
};

export type StreamToolCallDeltaEvent = {
  type: "tool_call_delta";
  id: string;
  messageId?: string;
  name?: string;
  argumentsRawDelta: string;
};

export type StreamToolCallEvent = {
  type: "tool_call";
  id: string;
  messageId?: string;
  name: string;
  arguments: JsonObject;
  argumentsRaw: string;
  /** Set when argumentsRaw is not a valid JSON object (arguments may be {}). */
  argumentsError?: string;
};

/** Emitted after one sequential tool execution has produced its result. */
export type StreamToolFinishedEvent = {
  type: "tool_finished";
  id: string;
  messageId: string;
  /**
   * Tool name that finished (underlying name when the call went through the
   * tool bridge). Optional for compatibility with older emitters; lets the
   * UI react per tool (e.g. refresh git stats after file writes).
   */
  name?: string;
};

/** Turn/runtime status signal (includes session statuses plus in-turn phases). */
export type StreamStatusValue = SessionStatus | "streaming" | "tool_running";

export type StreamStatusEvent = {
  type: "status";
  status: StreamStatusValue;
};

export type StreamProgressEvent = {
  type: "progress";
  text: string;
  /**
   * Tool this line is attributed to (running / args streaming / approval or
   * ask wait). Absent on model-phase lines ("Waiting for model…",
   * "Compacting context…"). Lets the UI drop the status row while the
   * tool's own card is on screen (Write/Patch cards self-describe).
   */
  toolName?: string;
};

/**
 * A model round was cut mid-stream by a queued interrupt prompt (non-terminal:
 * the turn stays and the round gate drains the prompt before the next model
 * call). UI cue: the interrupted round never reaches text/tool events, so live
 * streaming chrome (the Thinking CoT card spinner) must be sealed here —
 * otherwise it spins until a much later structural refresh.
 */
export type StreamRoundInterruptedEvent = {
  type: "round_interrupted";
  /** Assistant message the interrupted round was streaming into. */
  messageId: string;
};

export type StreamUsageEvent = {
  type: "usage";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Prompt tokens served from provider prompt cache (when reported). */
  cachedTokens?: number;
  /** Prompt tokens written into provider cache (when reported). */
  cacheWriteTokens?: number;
};

/**
 * Composer context-ring display only — does not update compact-trigger
 * `session.contextUsage.usedTokens`.
 */
export type StreamContextDisplayEvent = {
  type: "context_display";
  usedTokens: number;
  source: "provider" | "estimate";
  cachedTokens?: number;
};

export type StreamErrorEvent = {
  type: "error";
  message: string;
  returnCode?: number;
};

export type StreamDoneReason =
  | "completed"
  | "cancelled"
  | "paused"
  | "error";

export type StreamDoneEvent = {
  type: "done";
  reason: StreamDoneReason;
};

/** Multi-step plan update — mirrors Session.plan (persisted). */
export type StreamPlanEvent = {
  type: "plan";
  plan: import("../session/types.js").SessionPlan | null;
};

/** Workflow phase — mirrors Session.phase. */
export type StreamPhaseEvent = {
  type: "phase";
  phase: import("../session/types.js").Phase | null;
  /** Why the phase fell back to review (e.g. task extraction was rejected). */
  error?: string;
};

/** Presentation: Approve | Discard chrome pending (mirrors planDoc.approvalPending). */
export type StreamPlanApprovalEvent = {
  type: "plan_approval";
  pending: boolean;
  error?: string;
};

/** Subagent lifecycle / progress — parent session stream only. */
export type StreamSubagentEvent = {
  type: "subagent";
  id: string;
  parentToolCallId: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "error"
    | "cancelled";
  title: string;
  /** 0–100 scheduling priority (higher starts sooner when queued). */
  priority?: number;
  progressText?: string;
  summary?: string;
  errorMessage?: string;
  /** Child model-facing context window size (tokens). */
  usedTokens?: number;
};

/**
 * Subagent live output for the monitor overlay — throttled assistant text /
 * reasoning deltas plus tool call lines. Never written into session.messages;
 * rides the parent session stream channel only.
 */
export type StreamSubagentLiveEvent = {
  type: "subagent_live";
  id: string;
  name: string;
  role: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "error"
    | "cancelled";
  kind: "delta" | "reasoning" | "tool";
  /** Buffered assistant text (kind="delta") or thinking text (kind="reasoning"). */
  text?: string;
  /** Tool line (kind="tool" only); `finished` flips when it completes. */
  tool?: {
    id: string;
    name: string;
    summary: string;
    finished: boolean;
  };
};

/** Composer full-permissions toggle flipped mid-turn (UI sync). */
export type StreamFullPermissionsEvent = {
  type: "full_permissions";
  enabled: boolean;
};

/**
 * FSM node-visit telemetry (DevTools FSM Graph tab). One event per node
 * entry; `transition` names the routed edge that led in (omitted for the
 * entry visit and for selfLoop-fallback revisits). Subagent turns never
 * emit this — it rides the parent session stream only.
 */
export type StreamFsmNodeEvent = {
  type: "fsm_node";
  nodeId: string;
  phase: "enter";
  transition?: { from: string; to: string };
};

/** A pending user correction left the slot at a loop_head boundary. */
export type StreamSteerConsumedEvent = {
  type: "steer_consumed";
  id: string;
  applied: boolean;
};

/**
 * Mid-execution live payload for one tool call (e.g. rsync upload progress
 * streamed by the run_shell handler). Ephemeral UI data — never persisted
 * into session.messages; rides the session stream channel only (like
 * subagent_live). The renderer dispatches on `kind` and narrows `payload`.
 */
export type StreamToolLiveEvent = {
  type: "tool_live";
  toolCallId: string;
  /** Renderer dispatch key (e.g. "upload"). */
  kind: string;
  payload: import("../session/types.js").JsonObject;
};

/**
 * Full prompt-queue snapshot (not a delta) after any mutation: enqueue, edit,
 * remove, mode change, mid-turn drain or end-of-turn drain. The renderer
 * mirrors `items` verbatim — with several queued prompts, incremental patching
 * drifts from the main-process source of truth too easily.
 */
export type StreamPromptQueueEvent = {
  type: "prompt_queue";
  items: {
    id: string;
    sessionId: string;
    userText: string;
    attachments: {
      path: string;
      name: string;
      kind: string;
      mimeType: string;
      sizeBytes?: number;
    }[];
    createdAt: number;
    mode: "deferred" | "interrupt";
  }[];
};

/**
 * STOP landed before any model content: the cancelled turn's prompt was
 * dropped from the transcript (together with its empty assistant
 * placeholders) and is handed back to the composer for a second edit.
 * Emitted from the turn `finally` after the closing `done` event — the
 * renderer must still run a structural refresh to drop the optimistic
 * user card. Attachments whose local file vanished are filtered out
 * main-side before this event ships.
 */
export type StreamPromptRestoredEvent = {
  type: "prompt_restored";
  text: string;
  attachments: {
    path: string;
    name: string;
    kind: string;
    mimeType: string;
    sizeBytes?: number;
  }[];
};

export type StreamEvent =
  | {type:"transcript_changed"}
  | StreamTextDeltaEvent
  | StreamReasoningDeltaEvent
  | StreamHostedToolEvent
  | StreamResponseStateEvent
  | StreamToolCallDeltaEvent
  | StreamToolCallEvent
  | StreamToolFinishedEvent
  | StreamStatusEvent
  | StreamProgressEvent
  | StreamRoundInterruptedEvent
  | StreamUsageEvent
  | StreamContextDisplayEvent
  | StreamErrorEvent
  | StreamDoneEvent
  | StreamPlanEvent
  | StreamPhaseEvent
  | StreamPlanApprovalEvent
  | StreamSubagentEvent
  | StreamSubagentLiveEvent
  | StreamFullPermissionsEvent
  | StreamSteerConsumedEvent
  | StreamPromptQueueEvent
  | StreamPromptRestoredEvent
  | StreamFsmNodeEvent
  | StreamToolLiveEvent;
