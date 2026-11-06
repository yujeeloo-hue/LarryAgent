import type { StreamEvent } from "../llm/streamEvents.js";
import type {
  OpenAiCompatibleClientConfig,
  StreamChatOptions,
} from "../llm/types.js";
import {
  chatCompletionOnce,

} from "../llm/openaiCompatibleClient.js";
import type { HookRunner } from "../hooks/types.js";
import type { Session, SessionStatus } from "../session/types.js";
import type { PermissionGateState } from "../tools/types.js";
import type { AttachmentDraft, PendingSteer } from "./ipcTypes.js";

export type StreamChatFn = (
  config: OpenAiCompatibleClientConfig,
  options: StreamChatOptions,
) => AsyncGenerator<StreamEvent, void, undefined>;

export type SummarizeFn = typeof chatCompletionOnce;

export type RunAgentTurnInput = {
  session: Session;
  userText: string;
  /** Local files attached to this user turn. */
  attachments?: AttachmentDraft[];
  /**
   * Retry-click continuation: `userText` is the hidden "continue the task"
   * instruction. The persisted user message gets RETRY_CONTINUATION_PART_ID
   * (model-facing, UI-hidden; see agent/turnContinuations.ts).
   */
  continuation?: "retry";
  /**
   * Internal continuation: the leading `user` message is already persisted, so
   * this Turn must not append another one. Plan Approve writes the prompt up
   * front (fast UI feedback) and only then extracts tasks, which also keeps the
   * Plan card inside the new Turn instead of the previous one.
   */
  suppressUserMessage?: boolean;
  /**
   * Resume a turn paused by persisted ask_user: run any remaining same-batch
   * tools, then continue the model loop (no new user message).
   */
  resumeAfterUserAsk?: boolean;
  resumeToolBatch?: {
    assistantMessageId: string;
    toolCallIds: string[];
  };
  /**
   * Atomically remove and return ALL user corrections armed as interrupt
   * while this turn is running (the drain merges them into ONE inserted
   * user message). Parent turns only; drained at graph loop_head boundaries.
   */
  takePendingSteer?: () => PendingSteer[];
  /** Read-only companion used to avoid ending just before a queued steer drains. */
  hasPendingSteer?: () => boolean;
  /**
   * Atomically consume a queued /pause request (parent turns only). Checked at
   * round boundaries before budget evaluation; the turn finishes as `paused`.
   */
  takePauseRequested?: () => boolean;
  client: OpenAiCompatibleClientConfig;
  gate: PermissionGateState;
  /**
   * Composer: after Turn end gates pass, run skill_reflect mini-loop.
   * Default false.
   */
  autoSkillSummarize?: boolean;
  createId: () => string;
  signal?: AbortSignal;
  /**
   * Holder the turn host fills with its one-shot interrupt trigger (same
   * semantics as `TurnHost.requestInterrupt`); main-process enqueue fires
   * it for interrupt-mode prompts while this turn runs.
   */
  interruptPort?: { fire: (() => boolean) | null };
  /** Cap on model→tools→model iterations. Default 128 / settings. */
  maxModelIterations?: number;
  /**
   * Max billable tokens per turn (Σ provider total_tokens). Default 3_000_000.
   * Hitting the cap offers Continue / Stop (parent turns only).
   */
  maxTurnTokens?: number;
  /**
   * When true, skip max model iterations and max turn tokens
   * (composer Infinite switch; applies in any run mode). User cancel
   * still applies.
   */
  unlimitedTurnBudgets?: boolean;
  /** Model-facing context limit. Default 128000 / settings. */
  contextLimitTokens?: number;
  /** Compact when decision ≥ limit * ratio. Default 0.85. */
  compactTriggerRatio?: number;
  /** iterationProtectV1: newest raw iterations. Default 20. */
  iterationProtectRawIterationCount?: number;
  /** iterationProtectV1: protect token ratio. Default 0.2. */
  iterationProtectTokenRatio?: number;
  /**
   * When true, S3-uploaded image attachments render as multimodal
   * `image_url` content parts on the model wire (chat provider accepts
   * URL-based image input). Set by the main process when the chat provider
   * is multimodal AND object storage is enabled.
   */
  imageUrls?: boolean;
  /**
   * When true, tool results carrying image attachments with `s3.url` render
   * as multimodal `image_url` parts inside the tool message content (chat
   * provider accepts tool-role images — read_image direct). Set by the main
   * process from resolveToolRoleImageSupport for the session provider.
   */
  toolRoleImages?: boolean;
  /**
   * Upload one read_image target for the direct (tool-role image) path via
   * the session provider's resolved transport (S3 URL or base64 inline).
   * Returns null when the channel is unavailable or the upload fails — the
   * handler then falls back to the vision-relay description.
   */
  uploadReadImage?: (input: {
    imagePath: string;
    mimeType: string;
  }) => Promise<{ url: string; key: string } | null>;
  /**
   * Optional AGENT/SUBAGENT template override (tests / subagent manager).
   * Parent turns omit this and use resources/prompts/AGENT.md.
   */
  agentSystemPrompt?: string;
  /**
   * Live Environment context for this turn (flags + workspace + OS locale).
   * Omit to skip Environment injection.
   */
  environmentContext?: {
    flags: import("../settings/types.js").EnvironmentContextFlags;
    workspace: import("./environmentContext.js").EnvironmentWorkspaceSnapshot;
    locale: import("./environmentContext.js").EnvironmentLocaleSnapshot;
  };
  onEvent?: (event: StreamEvent) => void;
  /** Persist the transcript strictly before/after tool side effects. */
  checkpoint?: () => void | Promise<void>;
  /**
   * Optional desktop notification sink (self-owned toast/popup via
   * appNotify, shown whether the app is foreground or background). Main
   * process injects the implementation; omitted in tests and nested
   * subagent turns. Never throws.
   */
  desktopNotify?: (input: DesktopNotifyInput) => void;
  /**
   * Composer run-mode switch request sink (`NodeActionSetComposerRunMode`).
   * Main process injects the implementation (recorded, applied at turn
   * `finally`); omitted in tests and nested subagent turns. Never throws.
   */
  requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
  /**
   * Notification hub port for the notify tool (self-owned toast/popup +
   * bell inbox). Main-process only; tests and nested subagent turns omit.
   */
  notify?: import("../tools/notifyTool.js").NotifyToolPort;
  /**
   * FSM NodeAction shell-execution sink (`NodeActionRunShell`). Runs a shell
   * script (inline body or .sh file) in the session workspace; main process
   * injects the implementation, omitted in tests and nested subagent turns.
   * Graph config is user-authored and trusted — no permission gate inside.
   */
  runShell?: (input: FsmRunShellInput) => Promise<FsmRunShellResult>;
  /**
   * FSM session blackboard accessors (`NodeActionWriteBlackboard` /
   * `NodeActionReadBlackboard` / `NodeActionCompare`); main process only,
   * omitted in tests and nested subagent turns.
   */
  blackboardGet?: (key: string) => unknown;
  blackboardSet?: (
    key: string,
    value: unknown,
  ) => { ok: true } | { ok: false; error: string };
  streamChat?: StreamChatFn;
  /** Inject for tests; used by context compaction. */
  summarize?: SummarizeFn;
  /** Resolve vision client for read_image. */
  getVisionClient?: () => Promise<
    import("../tools/types.js").VisionClientConfig | null
  >;
  /** Resolve image-generation client for generate_image. */
  getImageGenClient?: () => Promise<
    import("../tools/types.js").ImageGenClientConfig | null
  >;
  /** Upload a generate_image input image to object storage (COS URL mode). */
  uploadImageGenInput?: (
    bytes: Uint8Array,
    mimeType: string,
    ext: string,
  ) => Promise<string>;
  /** Hook runner for this turn; omit to skip hooks. */
  hooks?: HookRunner;
  /**
   * When true, this turn is a nested subagent (no nested dispatch host).
   * Child tool filters come from the subagent graph / PrepareRole predicate.
   */
  isSubagentTurn?: boolean;
  /** Parent session id when isSubagentTurn. */
  parentSessionId?: string;
  /** Subagent run id when isSubagentTurn. */
  subagentId?: string;
  /**
   * Optional turn-wide tools[] filter (e.g. subagent child turns).
   * Parent Ask / Plan filters live on FSM NodeActions, not here.
   */
  toolPredicate?: (name: string) => boolean;
  /** Main-process session tools; never registered globally or inherited by children. */
  additionalTools?: import("../tools/types.js").RegisteredTool[];
  /** Extra ephemeral system message after the base agent prompt. */
  extraSystemPrompt?: string;
  /** Dedicated persona (CoCo commander); evaluated every model iteration. */
  resolvePersona?: () => import("./turnHost/buildSystemPrefix.js").PersonaOverride;
  /** Wire-only trailing user note (after the conversation, every iteration); never persisted or shown. */
  wireTrailingNote?: string;
  /**
   * Model window carries only the newest N user Turns (wire-only). Compaction
   * is skipped and hard-truncate is gated on the local window estimate.
   */
  conversationTurnLimit?: number;
  /**
   * Composer run mode for this turn (`agent` | `ask` | `plan` | `custom`).
   * Mapped once inside `resolveWorkflowMode` → FSM graph mode
   * (`react` | `ask` | `plan_execute`). Subagent turns ignore this and
   * always resolve to `subagent`. Custom mode supplies `fsmGraphConfig`.
   */
  runMode?: import("./ipcTypes.js").ComposerRunMode;
  /**
   * Library FSM graph id when `runMode` is `custom` (telemetry / viewer).
   */
  fsmGraphId?: string;
  /**
   * Pre-loaded custom FSM topology. When set, `FsmGraphWorkflow` runs this
   * config instead of `graphConfigForMode(mode)`.
   */
  fsmGraphConfig?: import("./fsm/types.js").FSMGraphConfig;
  /** Pre-built per-role LLM bindings. Default: uniform from `client`. */
  llmBundle?: import("./roles/types.js").RoleLlmBundle;
  /** Approve / Discard control intent for plan_execute. */
  controlIntent?: "approve" | "discard";
  /**
   * When isSubagentTurn, which subagent role filter/prompt overlay to use.
   * Default general.
   */
  subagentRoleKind?: import("./subagents/types.js").SubagentRole;
  /**
   * List all agent sessions across workspaces (search_session_history).
   * Forwarded to subagent child turns; omit when unavailable.
   */
  listAgentSessions?: () => import("../session/types.js").Session[];
  /**
   * Summarized session_history records (deleted sessions) for
   * search_session_history scope=history/all. Omit when unavailable.
   */
  listSessionHistory?: () => import("../session/db/sessionHistoryRepository.js").SessionHistoryRecord[];
  /**
   * Graph library port forwarded to the fsm_graph tool (delete guard
   * included). Omit when the host does not expose the library.
   */
  fsmGraphLibrary?: import("../tools/fsmGraphTool.js").FsmGraphLibraryPort;
  /** Turn-handoff port for the turn_handoff tool (main process only). */
  turnHandoff?: import("../tools/turnHandoffTool.js").TurnHandoffPort;
  /** Loops service port for the loops tool (main process only). */
  loops?: import("../tools/loopsTool.js").LoopsToolPort;
  /** Known workspaces (id + name) for search_session_history scoping. */
  listWorkspaces?: () => { id: string; name: string }[];
  /** Session DB for persisting subagent transcripts (parent turns only). */
  sessionDb?: import("../session/db/openDb.js").SessionDatabase;
};

export type DesktopNotifyInput = {
  title: string;
  body: string;
  /** Session the notification jumps to on click (bell inbox / popup). */
  sessionId?: string;
  /**
   * When true and the app is frontmost, show the in-app celebration confetti
   * on top of the toast (background turns always get the corner popup).
   */
  celebrate?: boolean;
};

export type RunAgentTurnResult = {
  status: SessionStatus;
  modelIterations: number;
};

/**
 * Shell-execution request from `NodeActionRunShell`. Exactly one of
 * `command` (inline script body) / `scriptPath` (relative to the workspace
 * root, or absolute) must be set — validated by the Action.
 */
export type FsmRunShellInput = {
  /** Inline shell script body. */
  command?: string;
  /** Path to a shell script file (workspace-relative or absolute). */
  scriptPath?: string;
  /** Working directory; defaults to the session workspace root. */
  cwd?: string;
  /** Extra env vars merged over `process.env`. */
  env?: Record<string, string>;
  /** Group-kill timeout in ms; default 60000. */
  timeoutMs?: number;
  /** Cooperative cancel (turn abort cascades here). */
  signal?: AbortSignal;
};

/** Structured outcome of one FSM shell execution. */
export type FsmRunShellResult = {
  /** "ok" — script ran and exited 0; "error" — nonzero exit / timeout / setup failure. */
  status: "ok" | "error";
  /** Shell exit code (null when killed by timeout / cancel / signal). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Script actually executed (inline body or file contents). */
  command: string;
  /** Resolved working directory. */
  cwd: string;
  /** Setup / spawn failure message (missing file, spawn error, …). */
  errorMessage?: string;
};

