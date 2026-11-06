import type { StreamEvent } from "../llm/streamEvents.js";
import type { ReasoningEffort } from "../llm/reasoningEffort.js";
import type {
  AttachmentKind,
  JsonObject,
  Session,
  SessionSource,
  SessionStatus,
  SessionType,
  UserMessage,
} from "../session/types.js";
import type { Workspace } from "../workspace/types.js";
import type { ToolApprovalRisk, ToolConfirmationSource } from "../tools/types.js";

/** Sidebar / list row (no full message payload). */
export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  status: SessionStatus;
  progressText: string;
  type: SessionType;
  messageCount: number;
  workspaceId: string;
  archived: boolean;
  archivedAt: number | null;
  /**
   * Origin marker ('app' default | 'subagent' | 'loop'). Omitted for plain
   * app sessions (same exposure rule as Session.source).
   */
  source?: SessionSource;
};

/** Local file chosen in the composer before send. */
/** Composer attachment draft (renderer → main). */
export type AttachmentDraft = {
  path: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes?: number;
  /**
   * Main-process only: set when the image was uploaded to object storage
   * before the turn started (see `uploadImageAttachmentsForTurn`).
   */
  s3?: { url: string; key: string };
};

/** Composer run mode for a turn. */
export type ComposerRunMode = "agent" | "ask" | "plan" | "custom";

export type StartTurnRequest = {
  /** Main-process Coco capability token; never accepted from IPC. */
  cocoExecutionId?: string;
  /** Omit to create a new session. */
  sessionId?: string;
  /** Required when creating a new session (falls back to active workspace). */
  workspaceId?: string;
  /**
   * Chat LLM profile for a **new** session. When omitted, uses settings
   * `activeProviderId` (default for new tasks). Ignored when continuing an
   * existing session — that session’s `providerId` is authoritative.
   */
  providerId?: string;
  /**
   * Explicit title for a **new** session (clamped to the sidebar title
   * length). Omitted → heuristic title from the prompt's first line.
   * CoCo dispatch passes the work title so the sidebar never shows the
   * internal work id; the id stays in the instruction text and records.
   */
  title?: string;
  userText: string;
  fullPermissions: boolean;
  /**
   * When true, eligible Turns may enter the pre-end skill_reflect phase
   * (auto-summarize reusable skills). Process-local Composer toggle.
   */
  autoSkillSummarize?: boolean;
  /**
   * Composer run mode.
   * - agent (default, UI: Auto) — ReAct
   * - ask (UI: Ask) — read-only Q&A, reasoning disabled
   * - plan — plan-and-execute (iterations/tokens budgets reset on each plan step-status change)
   * - custom — user FSM graph from the library (`fsmGraphId` required)
   * Settings default is agent/ask/plan only; custom is session-scoped.
   * The separate settings switch `composerInfinite` (any mode) lifts
   * iterations/tokens turn budget caps.
   */
  runMode?: ComposerRunMode;
  /**
   * Library FSM graph id when `runMode` is `custom`. Ignored otherwise.
   */
  fsmGraphId?: string;
  /**
   * @deprecated Prefer `runMode`. When `runMode` is omitted, true → plan.
   */
  planMode?: boolean;
  /**
   * Composer reasoning-effort dial level: "off" | "low" | "medium" |
   * "high" | "max". Omitted / invalid → main resolves the default ("low").
   * "off" maps onto provider-specific thinking-disable switches.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Composer Infinite switch for a **new** session (pinned onto the row;
   * existing sessions resolve from their own row → settings default).
   */
  composerInfinite?: boolean;
  /** Optional local files attached to this user turn. */
  attachments?: AttachmentDraft[];
  /**
   * Retry-click continuation: `userText` is a hidden "continue the task"
   * instruction (RETRY_CONTINUATION_PROMPT), not typed user input. Main
   * stamps the persisted user message with RETRY_CONTINUATION_PART_ID —
   * model-facing, but every conversation UI hides it, so the renderer must
   * not append an optimistic user row for this turn.
   */
  continuation?: "retry";
  /**
   * Main-process only (never sent from the renderer): the leading `user`
   * message is already persisted, so the Turn must not append another one.
   */
  suppressUserMessage?: boolean;
  /** Main-process only: continue after persisted ask_user answer. */
  resumeAfterUserAsk?: boolean;
  /** Remaining same-batch tools to run before resuming the model loop. */
  resumeToolBatch?: {
    assistantMessageId: string;
    toolCallIds: string[];
  };
  /** Main-process only: plan Approve / Discard control intent. */
  controlIntent?: "approve" | "discard";
  /**
   * Session origin marker persisted onto the sessions row (schema v15).
   * Omitted → DB default `'app'` (all existing callers unchanged); the
   * background Loops daemon passes `'loop'`. Only applied when creating a
   * new session — an existing session keeps its stored source.
   */
  source?: SessionSource;
  /**
   * Main-process / daemon only: run this turn without a renderer. Any
   * ask_user / request_full_permissions / turn-limit ask never waits — it
   * settles immediately as cancelled (same settle path as respondUserAsk)
   * so the turn keeps running instead of hanging forever.
   */
  headless?: boolean;
  /**
   * Main-process only (turn_handoff drain): this turn is a queued handoff
   * follow-up — it must not clear `pendingHandoff` or reset the chain depth
   * the way real user input does.
   */
  handoffChain?: boolean;
  /**
   * Main-process only (turn_handoff drain): one-shot FSM graph override for
   * THIS turn — forces runMode "custom" on this graph id without writing the
   * session row. Only honored together with `handoffChain`.
   */
  handoffGraphId?: string;
};

export type StartTurnResponse = {
  sessionId: string;
};

/**
 * How a queued prompt is meant to reach the agent.
 *
 * - `deferred`: wait for the **whole turn** to finish, then start a fresh
 *   turn with this prompt. The running turn is never interrupted.
 * - `interrupt`: armed for insertion into the running turn after active
 *   model/tool work finishes naturally. Enqueueing or arming does not abort
 *   the in-flight request or tool calls. The next graph round boundary
 *   (`NodeActionRoundGate` → `host.drainPendingSteer`) appends the message
 *   into the running transcript. All armed items drain together as ONE
 *   merged insertion at the first boundary.
 *
 * Legacy `"steer"` values from older remotes map to `interrupt` on intake
 * (see `normalizeQueuedPromptMode` in the pure queue core).
 */
export type QueuedPromptMode = "deferred" | "interrupt";

/** One user prompt waiting in the session's FIFO prompt queue. */
export type QueuedPrompt = {
  id: string;
  sessionId: string;
  userText: string;
  attachments: AttachmentDraft[];
  createdAt: number;
  mode: QueuedPromptMode;
  /** Work selected in CoCo Chat when this prompt was submitted. */
  cocoWorkId?: string;
};

/**
 * Host-facing alias for one drained queue item: by the time the turn host
 * sees it the insertion decision is already made, so `mode` carries no
 * meaning there. `takePendingSteer` returns ALL armed items at once and the
 * drain merges them into ONE inserted user message.
 */
export type PendingSteer = QueuedPrompt;

export type EnqueuePromptRequest = {
  sessionId: string;
  userText: string;
  attachments?: AttachmentDraft[];
  /** Omit for `deferred` — mid-turn insertion is always opt-in. */
  mode?: QueuedPromptMode;
  cocoWorkId?: string;
};

export type EnqueuePromptResponse = {
  queued: QueuedPrompt;
  items: QueuedPrompt[];
};

/**
 * Uniform reply for every queue mutation: callers re-render from `items`
 * instead of patching their local copy. `reason` is a machine-readable
 * failure cause (`not_found`, `not_running`, `cap`, …); `started` marks a
 * promote that began a turn right away because the session was idle.
 */
export type PromptQueueMutationResponse = {
  ok: boolean;
  reason?: string;
  started?: boolean;
  items: QueuedPrompt[];
};

export type AgentStreamPayload = {
  sessionId: string;
  event: StreamEvent;
};

/** Level-2 tool confirmation — ephemeral UI, not persisted on the session. */
export type ToolApprovalRequestPayload = {
  requestId: string;
  sessionId: string;
  toolName: string;
  arguments: JsonObject;
  /** Epoch ms when the auto-deny timer fires (LEVEL2_CONFIRMATION_TIMEOUT_MS). */
  expiresAt: number;
  /** Shell Safe Mode risk context for the approval card, when present. */
  risk?: ToolApprovalRisk;
  source?: ToolConfirmationSource;
};

export type ToolApprovalDismissPayload = {
  requestId: string;
  sessionId: string;
};

export type ToolApprovalResponseRequest = {
  requestId: string;
  approved: boolean;
};

/**
 * ask_user — live UI on the tool card. Main persists pending asks and keeps
 * a live map so remounting and app restart can rehydrate the panel.
 */
export type UserAskRequestPayload = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  question: string;
  /** Empty array = open-ended ask (free-form input only). */
  options: string[];
  optionDetails?: import("../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  /** When true, user may pick multiple options before confirming. */
  allowMultiple: boolean;
};

export type UserAskDismissPayload = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
};

export type UserAskResponseRequest = {
  requestId: string;
  /** Null / omit when the user cancels without answering. */
  selected?: string | null;
  /** Multi-select option labels (non-custom). Preferred over joined `selected`. */
  selections?: string[] | null;
  custom?: boolean;
  comment?: string;
};

export type CreateWorkspaceRequest = {
  name: string;
  path: string;
  /** "coco" only from the CoCo-internal path; the workspace:create IPC strips it. */
  origin?: "coco";
};

export type UpdateWorkspaceRequest = {
  id: string;
  name?: string;
  path?: string;
};

export function toSessionSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    status: session.status,
    progressText: session.progressText,
    type: session.type,
    messageCount: session.messages.length,
    workspaceId: session.workspaceId,
    archived: session.archived,
    archivedAt: session.archivedAt,
    ...(session.source ? { source: session.source } : {}),
  };
}

export type { Workspace };
export type { SessionSearchHit } from "./searchSessions.js";
