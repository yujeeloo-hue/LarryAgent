/**
 * Domain types for Session / Message / Part.
 * Decided with the project owner — no agent-loop behavior here.
 */

/** Epoch milliseconds. */
export type TimestampMs = number;

export type SessionType = "agent";

/**
 * Session origin: app UI, subagent, application-owned Coco, or historical
 * Loop execution. Persisted as `sessions.source` (schema v15).
 */
export type SessionSource = "app" | "subagent" | "loop" | "coco" | "coco_chat" | "coco_internal";

/** Runtime guard for values read back from the `source` column. */
export function isSessionSource(value: unknown): value is SessionSource {
  return value === "app" || value === "subagent" || value === "loop" || value === "coco" || value === "coco_chat" || value === "coco_internal";
}

/** `paused`: graceful /pause stop at a round boundary; resumable via /resume. */
export type SessionStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "cancelled";

/** Stored on the session; limit is `contextLimitTokens` in settings. */
export type SessionContextUsage = {
  /**
   * Compact-trigger / authority value.
   * Prefer last provider `prompt_tokens`; local BPE estimate only until the first usage.
   */
  usedTokens: number;
  /**
   * Composer ring display value (may lead `usedTokens` during a turn).
   * Live formula: last provider `usedTokens` + user-prompt estimate +
   * streamed text/tool_call_delta estimates; corrected when provider usage arrives.
   * Does not affect compaction triggers.
   */
  displayUsedTokens?: number;
  /** From provider `prompt_tokens_details.cached_tokens` when reported. */
  cachedTokens?: number;
  /** Whether `usedTokens` came from provider usage or a local estimate. */
  source?: "provider" | "estimate";
  /**
   * Local BPE estimate of the exact request the provider usage measured. That
   * request may be smaller than the next full window (hard-truncated,
   * turn-limited, or sent before a large tool result), so the gate adds the
   * estimated growth since then on top of the provider reading.
   */
  requestEstimateTokens?: number;
};

/** Max length of a plan-doc summary (SessionPlanDoc.summary + plan ref summary). */
export const PLAN_DOC_SUMMARY_MAX = 400;

/** Per-step status for the multi-step plan tools. */
export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

/** Overall plan status. */
export type PlanStatus = "active" | "completed" | "cancelled";

export type PlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
  /** Step ids that must be completed before this step can start. Omit or [] = none. */
  dependsOn?: string[];
};

/**
 * Latest multi-step plan for the session (persisted).
 * Historical plans are reconstructed from create_plan / update_plan / complete_plan tool calls.
 */
export type SessionPlan = {
  id: string;
  title: string;
  status: PlanStatus;
  steps: PlanStep[];
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  /** tool_call id of create_plan — anchors the rich Plan card. */
  createToolCallId: string;
  /** Optional wrap-up from complete_plan. */
  summary?: string;
  /** When false, renderer hides the Plan card. Default true. */
  cardVisible?: boolean;
  /**
   * Link to the docs/plans/ document this plan belongs to: { path, summary }
   * stamped when the plan is created with a doc present (or when a doc lands
   * while the plan is active). Kept after complete_plan clears
   * Session.planDoc, so a finished plan still names its source document.
   */
  planDoc?: {
    path: string;
    summary: string;
  };
};

/**
 * Markdown plan document under docs/plans/ (written before create_plan in plan mode).
 * Path + short summary only — body stays on disk.
 */
export type SessionPlanDoc = {
  path: string;
  summary: string;
  updatedAt: TimestampMs;
  /** SHA-256 of the current document body; approval applies to this revision only. */
  revision?: string;
  reviewedRevision?: string;
  approvedRevision?: string;
  approvedAt?: TimestampMs;
  /** Explicit human execution request, captured for this document revision. */
  executionRequestedRevision?: string;
  /**
   * Presentation: show Approve | Discard chrome.
   * Set when the plan is ready for a user decision; cleared on Approve / Discard.
   * Not an FSM phase — UI must not key off Session.phase.
   */
  approvalPending?: boolean;
  /**
   * Execution checklist staged by the plan reviewer via create_plan while
   * waiting for Approve. Survives review idle; Approve prefers this over LLM extract.
   */
  stagedPlan?: {
    title: string;
    steps: Array<string | { title: string; dependsOn?: string[] }>;
    updatedAt: TimestampMs;
  };
};

/**
 * Workflow phase (persisted on Session.phase).
 * Opaque string configured by the graph (Set phase / phaseResume); null when idle.
 */
export type Phase = import("./phase.js").Phase;
/** @deprecated Use {@link Phase}. */
export type PlanPhase = Phase;

export type MessageRole = "user" | "assistant" | "system" | "tool";

/** Text-part marker for a user correction that continues the current Turn. */
export const STEER_CONTINUATION_PART_ID = "turn-continuation:steer";

/**
 * turn_handoff drain-authored prompt marker: the drain persists the queued
 * handoff prompt as the next turn's user message with this text-part id, so
 * renderers/tests can distinguish it from a typed prompt.
 */
export const HANDOFF_PROMPT_PART_ID = "turn-continuation:handoff";

/**
 * Retry-continuation prompt marker: an error card's Retry click starts a
 * turn whose user message asks the model to continue the interrupted task
 * (see RETRY_CONTINUATION_PROMPT in agent/turnContinuations.ts). The
 * message is persisted and model-facing, but EVERY conversation UI hides
 * it — the original prompt stays in the transcript, so resending it would
 * duplicate the bubble and make the model redo finished work.
 */
export const RETRY_CONTINUATION_PART_ID = "turn-continuation:retry";

export type ToolCallStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export type AttachmentKind =
  | "image"
  | "file"
  | "audio"
  | "video"
  | "source_code";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export type TextPart = {
  type: "text";
  text: string;
  /** Responses citations/annotations, retained independently of encrypted state. */
  annotations?: JsonObject[];
  id?: string;
  /**
   * File a `file_diff` part belongs to (absolute, POSIX-style). Emitted by
   * the patch tool so the renderer can pair diffs with files without
   * zipping report text lines — that zip drifts on delete-containing
   * patches and clipped reports.
   */
  path?: string;
  /** True when the user rewrote this prompt mid-turn (display marker only). */
  edited?: boolean;
  /** True when this system text reports a failure (error card + Retry). */
  error?: boolean;
};

/**
 * Provider chain-of-thought (e.g. DeepSeek `reasoning_content`).
 * Persisted for wire echo on later model iterations; UI may show a Thought block.
 */
export type ReasoningPart = {
  type: "reasoning";
  text: string;
  /** Opaque binding scope. Foreign/unverified reasoning stays display-only. */
  providerScope?: string;
  id?: string;
  /** Wall time from first to last reasoning delta in this model iteration. */
  durationMs?: number;
  /** Local BPE estimate of `text` (display); not provider authority. */
  tokenCount?: number;
};

/** Provider-owned execution: never sent to the local tool runner. */
export type HostedToolPart = {
  type: "hosted_tool";
  id: string;
  name: string;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  item?: JsonObject;
};

/** Exact native output for scoped replay and durable server continuation. UI-hidden. */
export type ModelResponsePart = {
  type: "model_response";
  providerScope: string;
  model?: string;
  responseId: string;
  status: string;
  stored: boolean;
  output: JsonObject[];
  contextHash?: string;
  contextLength?: number;
  /** Opaque input-item fingerprints let recovery seal a completed server cursor. */
  requestItemHashes?: string[];
  /** Approval inputs that have been decided locally but not sent yet. */
  continuationInput?: JsonObject[];
  /** A lost request may have performed provider-owned side effects. */
  hostedEffects?: boolean;
  /** Actual submitted request capabilities; absent on legacy checkpoints. */
  requestSafety?: "read_only" | "effects_possible";
  /**
   * Native output must not be replayed (it may re-run approved hosted work);
   * history falls back to visible text and local tool records only.
   */
  contextReplayBlocked?: boolean;
  /** Completed snapshot a continuation was built on; restored if its outcome is lost. */
  resumeFrom?: Omit<ModelResponsePart, "type" | "resumeFrom">;
};

export type AttachmentS3Info = {
  /** Model-facing URL (presigned or public per settings urlMode). */
  url: string;
  /** Object key in the bucket (for re-presign / deletion). */
  key: string;
};

export type AttachmentPart = {
  type: "attachment";
  kind: AttachmentKind;
  uri: string;
  mimeType: string;
  name?: string;
  sizeBytes?: number;
  id?: string;
  /**
   * Present when the image was uploaded to S3/COS object storage before the
   * turn started. Multimodal wire assembly renders these as `image_url`
   * content parts instead of the read_image path stub.
   */
  s3?: AttachmentS3Info;
  /**
   * Inline downscaled raster preview (bare base64, no data: prefix) so
   * surfaces that cannot read the local file — the remote web console —
   * can render the image without a binary fetch channel. Produced by the
   * display_image / generate_image / capture_app_window handlers; the Mac
   * renderer ignores it and loads `uri` via media:// instead. Never sent
   * to the model — wire assembly reads text parts only.
   */
  thumbnailBase64?: string;
  /** MIME type of `thumbnailBase64` (image/jpeg, image/png, image/svg+xml). */
  thumbnailMimeType?: string;
  /**
   * Inline demo HTML (bare base64, no data: prefix) produced by present_demo:
   * surfaces without local file access — the remote web console — render it
   * in a sandboxed iframe via srcdoc. The Mac renderer ignores it and loads
   * `uri` (jellybot-file) instead. Never sent to the model — wire assembly
   * reads text parts only.
   */
  htmlBase64?: string;
};

/**
 * Parts allowed inside `tool_result.content`.
 * Must not nest `tool_call` or `tool_result`.
 */
export type ToolResultContentPart = TextPart | AttachmentPart;

export type ToolCallPart = {
  type: "tool_call";
  id: string;
  name: string;
  status: ToolCallStatus;
  arguments: JsonObject;
  argumentsRaw: string;
  /** Set when argumentsRaw failed to parse as a JSON object. */
  argumentsError?: string;
  /**
   * Wall time the call took, stamped onto the transcript part at its
   * terminal transition (presentation-only; older sessions lack it).
   */
  durationMs?: number;
};

export type ToolResultPart = {
  type: "tool_result";
  toolCallId: string;
  content: ToolResultContentPart[];
  returnCode: number;
  /** One-line English template summary of the tool run (no LLM). */
  executionSummary?: string;
};

export type ContextCompactionWarmFold = {
  userMessageId: string;
  text: string;
};

/** Marker appended when context is compacted; older messages stay intact. */
export type ContextCompactionPart = {
  type: "context_compaction";
  id: string;
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  usedTokensBefore: number;
  usedTokensAfter: number;
  /**
   * Last Cold Turn's user message id covered by this summary.
   */
  coveredThroughUserMessageId?: string;
  /**
   * Last transcript message id covered by a rolling summary
   * (iterationProtectV1 and similar strategies).
   */
  coveredThroughMessageId?: string;
  /** Number of Cold Turns covered when this marker was written. */
  coldTurnCount?: number;
  /** LLM structured folds for Warm Turns (Role/Action/Args/Result). */
  warmFolds?: ContextCompactionWarmFold[];
  /**
   * Mechanically rebuilt verbatim appendix ("Demo decisions (verbatim):" —
   * one entry per present_demo confirmation, latest per toolCallId, 20 FIFO)
   * appended after `summary` in the model window. Rebuilt from the full
   * transcript on every compaction — never relies on LLM fidelity.
   */
  demoVerbatim?: string;
};

/** Marker appended when the conversation is cleared; older messages stay in
 * the DB, but the model window and the conversation view start after it. */
export type ContextClearPart = {
  type: "context_clear";
  id: string;
  /** Transcript message count hidden by this clear. */
  clearedMessageCount: number;
};

/** Snapshot of Hot / Warm / Cold Turn counts. */
export type SessionContextBuckets = {
  hotTurnCount: number;
  warmTurnCount: number;
  hot: number;
  warm: number;
  cold: number;
  updatedAt: TimestampMs;
};

export type MessagePart =
  | TextPart
  | ReasoningPart
  | HostedToolPart
  | ModelResponsePart
  | ToolCallPart
  | ToolResultPart
  | AttachmentPart
  | ContextCompactionPart
  | ContextClearPart;

type MessageBase = {
  id: string;
  parts: MessagePart[];
  createdAt: TimestampMs;
};

export type UserMessage = MessageBase & {
  role: "user";
};

export type SystemMessage = MessageBase & {
  role: "system";
};

export type AssistantMessage = MessageBase & {
  role: "assistant";
  /** Optional index link when this message contains `tool_call` parts. */
  toolCallId?: string;
};

export type ToolMessage = MessageBase & {
  role: "tool";
  toolCallId: string;
};

export type Message =
  | UserMessage
  | SystemMessage
  | AssistantMessage
  | ToolMessage;

export type Session = {
  id: string;
  type: SessionType;
  /**
   * Origin marker ('app' default | 'subagent' | 'loop'). Omitted for plain
   * app sessions so existing objects stay unchanged; only non-default
   * origins are exposed after loading.
   */
  source?: SessionSource;
  title: string;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  status: SessionStatus;
  progressText: string;
  messages: Message[];
  /** Model id from the session’s bound provider profile. */
  model: string;
  /** Chat LLM provider profile id for this session (not process-wide). */
  providerId: string;
  /** Workspace this session belongs to. */
  workspaceId: string;
  /** Absolute project root for tools; kept in sync with Workspace.path. */
  workspacePath: string;
  pinned: boolean;
  /**
   * Session-level archive. Archived sessions leave the PROJECTS tree and
   * appear under the workspace group in the Archived sidebar.
   */
  archived: boolean;
  archivedAt: TimestampMs | null;
  contextUsage: SessionContextUsage;
  /**
   * Latest Hot/Warm/Cold Turn counts (updated on turn end; Phase 2 Logs UI).
   */
  contextBuckets?: SessionContextBuckets;
  /**
   * Latest multi-step plan (create_plan / update_plan / complete_plan).
   * Persisted; survives turn end until completed/cancelled/replaced.
   */
  plan: SessionPlan | null;
  /**
   * Latest plan markdown doc under docs/plans/ (plan_execute gate).
   * Cleared when the plan is completed/cancelled; rewritten for a new plan.
   */
  planDoc?: SessionPlanDoc | null;
  /**
   * @deprecated Prefer fsmBlackboard key `phase` (getSessionPhase). Mirrored on
   * write / load-migrated from the DB column for compat.
   * Workflow gate: gathering → drafting → review → planning → executing.
   */
  phase?: Phase | null;
  /**
   * Persisted ask_user pause. Turn ends idle until the user answers; answer
   * IPC resumes the same turn (survives app restart).
   */
  pendingUserAsk?: import("./pendingUserAsk.js").SessionPendingUserAsk | null;
  /**
   * Per-session composer prefs (schema v14). `null` = not customized →
   * runtime falls back to the process-wide defaults in settings.json;
   * the first in-session toggle pins the value on the row.
   * Regular upserts never overwrite these — only the dedicated
   * `updateComposerPrefs` repository call writes them.
   */
  composerRunMode?: import("../agent/ipcTypes.js").ComposerRunMode | null;
  /**
   * Selected user FSM graph id when `composerRunMode === "custom"`
   * (schema v17). Null/absent when using a builtin mode.
   */
  composerFsmGraphId?: string | null;
  composerInfinite?: boolean | null;
  /**
   * Per-session reasoning-effort dial level (schema v21): "off" | "low" |
   * "medium" | "high" | "max". Null = follow the settings.json default.
   */
  reasoningEffort?: import("../llm/reasoningEffort.js").ReasoningEffort | null;
  /**
   * turn_handoff session gate (schema v20): composer Self Learning toggle.
   * `null`/false = disabled (default) — the tool fails every call with
   * `handoff_disabled`. Same pin semantics as the other composer prefs:
   * written only via the dedicated `updateComposerPrefs` path.
   */
  handoffEnabled?: boolean | null;
  /**
   * Last FSM state actually executed (DevTools FSM Graph tab; schema v16).
   * OrchestratorMode (agent/roles/types.ts) inlined — this file is followed
   * by the web tsconfig via streamEvents, so it must stay renderer-safe.
   * `fsmLastGraphMode` picks the displayed graph; `fsmLastNodeId` seeds the
   * initial highlight until live `fsm_node` events arrive. Written from
   * sessionRuntime telemetry; NULL = never ran a turn.
   * When a custom library graph ran, `fsmLastGraphId` is set (schema v17)
   * and the viewer loads that config instead of a builtin mode.
   */
  fsmLastGraphMode?:
    | "react"
    | "ask"
    | "plan_execute"
    | "subagent"
    | null;
  /** Library graph id of the last custom-graph turn (schema v17). */
  fsmLastGraphId?: string | null;
  fsmLastNodeId?: string | null;
  fsmLastNodeAt?: number | null;
  /**
   * FSM session blackboard (schema v19): session-scoped key/value store for
   * NodeActionWriteBlackboard / ReadBlackboard / Compare. JSON blob in
   * the sessions table; rides in-memory session upserts like fsmLastGraphId.
   * Null = never written.
   */
  fsmBlackboard?: Record<string, unknown> | null;
};
