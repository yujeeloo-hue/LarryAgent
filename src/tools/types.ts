import type { UserAskAnswer } from "../shared/askUser.js";
import type { JsonObject, ToolResultContentPart } from "../session/types.js";

export type { JsonObject };

/** Per-tool permission level: 0 allow, 1 full-permission gate, 2 confirm each run. */
export type PermissionLevel = 0 | 1 | 2;

/**
 * Rewrite instruction produced by a risk assessor (rm → Trash move).
 * Applied by the tool-execution pipeline instead of the raw handler.
 */
export type ToolRiskRewrite = {
  type: "trash";
  /** Absolute resolved targets in argument order. */
  targets: string[];
  /** Tolerate missing targets silently (rm -f). */
  force: boolean;
  originalCommand: string;
};

/**
 * Content-aware risk verdict for one tool invocation (Shell Safe Mode).
 * - allow: Safe-Mode fast path (bypasses the level gate); optional rewrite.
 * - defer: no opinion — fall through to the plain level matrix unchanged.
 * - confirm: route to the confirmation card (fatal = both modes,
 *   otherwise Safe Mode only — assessors decide using fullPermissionsEnabled);
 *   an approved confirm carries its rewrite so the execution is the
 *   recoverable variant (Trash move), never the raw hard delete.
 * - block: denied outright (rmUnrewritable / fatalPolicy "block").
 */
export type ToolRiskAssessment =
  | { action: "allow"; rewrite?: ToolRiskRewrite }
  | { action: "defer" }
  | {
      action: "confirm";
      fatal: boolean;
      reason: string;
      hint?: string;
      /** Applied when the user approves (rm → Trash move). */
      rewrite?: ToolRiskRewrite;
    }
  | { action: "block"; reason: string; hint?: string };

export type ToolRiskAssessor = (input: {
  arguments: JsonObject;
  fullPermissionsEnabled: boolean;
  /** Supervised (CoCo) turns: high-risk findings still confirm under Bypass. */
  reviewHighRisk?: boolean;
  /** Workspace root for path resolution (may be empty in exotic hosts). */
  workspacePath?: string;
}) => ToolRiskAssessment;

/**
 * Risk context surfaced on the level-2 approval card (Shell Safe Mode).
 * Flattened from a ToolRiskAssessment "confirm" verdict by permissions.ts.
 */
export type ToolApprovalRisk = {
  /** True when the finding was fatal (asks even under Bypass). */
  fatal: boolean;
  /** Assessor's human-facing risk sentence (first line of the reason block). */
  reason: string;
  /** True when approving executes the recoverable Trash-routed variant. */
  trashRewrite: boolean;
};

/** Why a confirmation was requested: per-tool Ask level, Shell risk finding, or a Hook `ask`. */
export type ToolConfirmationSource = "ask_level" | "shell_risk" | "hook_ask";

/** Built-in tool names (fixed catalog). */
export type BuiltinToolName =
  | "read_file"
  | "write_file"
  | "patch"
  | "run_shell"
  | "exec_command"
  | "upload_files"
  | "list_dir"
  | "grep"
  | "symbols"
  | "batch_search"
  | "find_cxx_references"
  | "ask_user"
  | "request_full_permissions"
  | "search_tools"
  | "tool_describe"
  | "tool_call"
  | "read_image"
  | "display_image"
  | "generate_image"
  | "capture_app_window"
  | "convert_to_pdf"
  | "display_pdf"
  | "present_demo"
  | "get_workspace_path"
  | "get_current_time"
  | "create_mcp_server"
  | "update_mcp_server"
  | "delete_mcp_server"
  | "create_skill"
  | "update_skill"
  | "delete_skill"
  | "read_skill"
  | "search_skills"
  | "write_skill_file"
  | "install_skill"
  | "create_plan"
  | "update_plan"
  | "complete_plan"
  | "fsm_route"
  | "fsm_graph"
  | "fsm_graph_edit"
  | "report_step_blocked"
  | "write_plan_doc"
  | "adopt_plan_doc"
  | "read_user_memory"
  | "update_user_memory"
  | "read_project_memory"
  | "update_project_memory"
  | "search_session_history"
  | "dispatch_subagent"
  | "await_subagent"
  | "subagent_batch_result"
  | "get_subagent_status"
  | "list_subagents"
  | "stop_subagent"
  | "turn_handoff"
  | "dev_tasks"
  | "loops"
  | "notify";

/**
 * Registry / LLM tool name.
 * Built-ins use {@link BuiltinToolName}; MCP tools use `mcp__{serverId}__{tool}`.
 */
export type ToolName = BuiltinToolName | (string & {});

export type ToolDefinition = {
  name: string;
  /** Model-facing instructions; human UI copy lives in uiDescriptions.ts. */
  description: string;
  /** JSON-schema-like parameter description for the model (shape TBD with provider). */
  parameters: JsonObject;
  /** Optional compatibility schema used only at execution; never advertised to models. */
  validationParameters?: JsonObject;
  /** Built-in default; may be overridden at runtime via tool config. */
  defaultPermissionLevel: PermissionLevel;
  /**
   * Optional content-aware risk assessor (Shell Safe Mode). Runs before the
   * level logic in checkToolPermission: "allow" is a Safe-Mode fast path,
   * "confirm"/"block" route to the confirmation card / denial. Return
   * "none" to fall through to the plain level matrix unchanged.
   */
  assessRisk?: ToolRiskAssessor;
};

export type { UserAskAnswer } from "../shared/askUser.js";

export type VisionClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** When true, `baseUrl` is the full endpoint — used as-is, no path appended. */
  rawEndpoint?: boolean;
  apiProtocol?: import("../llm/apiProtocol.js").LlmApiProtocol;
};

export type ImageGenClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** When true, `baseUrl` is the full images endpoint — used as-is. */
  rawEndpoint?: boolean;
  /**
   * Explicit watermark preference forwarded as `watermark` in the request
   * body (Volcano Ark doubao-seedream). Omit = provider default (not sent).
   */
  watermark?: boolean;
  /**
   * How generate_image input images are encoded on the wire:
   * "base64" (inline) or "url" (object storage upload). Omit = image
   * input disabled for this provider.
   */
  imageInput?: "base64" | "url";
};

export type UserAskRequestInput = {
  question: string;
  /** Empty array = open-ended ask (free-form input only). */
  options: string[];
  optionDetails?: import("../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple?: boolean;
  /** Same-batch resume metadata (persisted for app-restart recovery). */
  assistantMessageId?: string;
  remainingToolCallIds?: string[];
};

export type ToolExecuteContext = {
  /** CoCo only: resolve an in-scope project's root by workspace id (throws otherwise). */
  cocoProjectPath?: (workspaceId: string) => string;
  cocoShell?: (input: import("./shellExec.js").ShellExecInput) => Promise<import("./shellExec.js").ShellExecResult>;
  cocoMcpCall?: (serverId: string, tool: string, args: JsonObject, signal?: AbortSignal) => Promise<ToolExecuteResult>;
  assertPath?: (path: string) => void;
  workspacePath: string;
  /** Current agent session id (for session history tools). */
  sessionId?: string;
  /** Current workspace id (for session history tools). */
  workspaceId?: string;
  /**
   * List all agent sessions across workspaces (live in-memory store).
   * Used by search_session_history.
   */
  listAgentSessions?: () => import("../session/types.js").Session[];
  /**
   * Graph library port for the fsm_graph tool (wired in the main-process
   * host). Structurally typed so tools never statically import agent/fsm.
   */
  fsmGraphLibrary?: import("./fsmGraphTool.js").FsmGraphLibraryPort;
  /**
   * Turn-handoff port for the turn_handoff tool (wired in the main-process
   * host): session gate state + queue/cancel of the post-turn handoff.
   * Structurally typed so tools never statically import agent/fsm.
   */
  turnHandoff?: import("./turnHandoffTool.js").TurnHandoffPort;
  /**
   * Loops service port for the loops tool (wired in the main-process
   * host). Structurally typed so tools never statically import main/loops.
   */
  loops?: import("./loopsTool.js").LoopsToolPort;
  /**
   * Notification hub port for the notify tool (wired in the main-process
   * host). Structurally typed so tools never statically import
   * main/appNotify.
   */
  notify?: import("./notifyTool.js").NotifyToolPort;
  /**
   * List known workspaces (id + name) for search_session_history
   * scope resolution and result labels.
   */
  listWorkspaces?: () => { id: string; name: string }[];
  /**
   * List summarized session_history records (deleted sessions) for
   * search_session_history scope=history/all and archive reads.
   */
  listSessionHistory?: () => import("../session/db/sessionHistoryRepository.js").SessionHistoryRecord[];
  /** Composer full-permissions toggle for this turn. */
  fullPermissionsEnabled: boolean;
  /** Trusted turn-input go-ahead for the current plan; never supplied in tool arguments. */
  planExecutionRequested?: boolean;
  requirePlanDocApprovalForCreatePlan?: boolean;
  /**
   * Headless (Loops daemon) turn: no renderer can answer interactive asks.
   * When an ask auto-settles as cancelled, tools surface the headless note
   * (HEADLESS_ASK_CANCELLED_TEXT) instead of the plain "user cancelled" text.
   */
  headlessMode?: boolean;
  /**
   * True when this batch runs inside a subagent turn — no user-facing card
   * with a confirm channel exists (present_demo refuses).
   */
  subagentTurn?: boolean;
  signal?: AbortSignal;
  /** Current tool_call id (for create_plan anchoring). */
  toolCallId?: string;
  /**
   * Enable full permissions for the rest of this turn (and notify the UI).
   * Used by request_full_permissions after the user Approves.
   */
  enableFullPermissions?: () => void;
  /**
   * Bridge scope for search_tools / tool_describe / tool_call (allow/deny).
   * Unset allowlist = all deferred except denylist.
   */
  bridgeScope?: {
    allowlist?: ReadonlySet<string>;
    denylist?: ReadonlySet<string>;
  };
  /**
   * For ask_user: show an interactive choice card and wait for the answer.
   * Returns null when cancelled / aborted.
   */
  requestUserAsk?: (
    input: UserAskRequestInput,
  ) => Promise<UserAskAnswer | null>;
  /**
   * Reset the parent turn's model-iteration budget (ask_user success).
   * No-op on subagent turns / when unlimited.
   */
  resetModelIterations?: () => void;
  /** Read-only plan snapshots for this tool batch (not the live Session). */
  planSnapshot?: import("../session/types.js").SessionPlan | null;
  planDocSnapshot?: import("../session/types.js").SessionPlanDoc | null;
  /**
   * When true, create_plan fails unless planDocSnapshot has a path.
   */
  requirePlanDocForCreatePlan?: boolean;
  /**
   * Route events the current FSM node actually binds (RouteTo). `fsm_route`
   * rejects anything else so a stray route name comes back to the model as a
   * tool error it can correct, instead of reaching a router with nowhere to go.
   * Absent (custom graphs / no RouteTo) → no validation.
   */
  boundRouteEvents?: string[];
  /**
   * Set by the FSM (NodeActionRunTools `shellReceipt: "structured"`), never by
   * tool arguments: the shell tool also returns a structured `receipt`.
   */
  shellStructuredReceipt?: boolean;
  /**
   * Resolve the dedicated vision / multimodal client for read_image.
   * Returns null when Vision is not configured in settings or the key store.
   */
  getVisionClient?: () => Promise<VisionClientConfig | null>;
  /**
   * Resolve the dedicated image-generation client for generate_image.
   * Returns null when the ImageGen profile is not configured.
   */
  getImageGenClient?: () => Promise<ImageGenClientConfig | null>;
  /**
   * Upload one generate_image input image to object storage (S3/COS) and
   * return its model-facing URL. Provided when the active ImageGen profile
   * uses imageInput "url" and object storage is configured.
   */
  uploadImageGenInput?: (
    bytes: Uint8Array,
    mimeType: string,
    ext: string,
  ) => Promise<string>;
  /**
   * Upload one read_image target for the direct tool-role image path
   * (session provider accepts tool-result images). Returns null when the
   * channel is unavailable or the upload fails — read_image then falls
   * back to the vision-relay description.
   */
  uploadReadImage?: (input: {
    imagePath: string;
    mimeType: string;
  }) => Promise<{ url: string; key: string } | null>;
  /**
   * Parent-turn subagent host (dispatch / await / status / list / stop).
   * Omitted on subagent turns and when unavailable.
   */
  subagents?: import("../agent/subagents/types.js").SubagentHost;
  /**
   * Stream a live payload for this tool call to the renderer mid-execution
   * (e.g. rsync upload progress → kind "upload"). Ephemeral UI data —
   * nothing is persisted; wired by the tool-execution pipeline (runTools).
   */
  emitLive?: (kind: string, payload: JsonObject) => void;
};

export type ToolExecuteResult = {
  content: ToolResultContentPart[];
  returnCode: number;
  /** Complete session projection; applied by runTools via Host, not a later Action. */
  sessionPatch?: import("../agent/contracts/index.js").SessionPatch;
  /**
   * Optional FSM route event for this successful call. runTools enqueues it;
   * EmitRouteEvent flushes last-wins onto nodeContext (never a node id).
   */
  routeEvent?: import("../agent/contracts/index.js").RouteEventPatch;
  /**
   * Structured execution facts for deterministic FSM checks. Returned to the
   * caller of runTools only — never persisted and never sent to the model.
   */
  receipt?: JsonObject;
};

export type ToolHandler = (
  args: JsonObject,
  context: ToolExecuteContext,
) => Promise<ToolExecuteResult>;

/** Inputs for a one-line, template-based execution summary (no LLM). */
export type ToolExecutionSummaryInput = {
  args: JsonObject;
  returnCode: number;
  content: ToolResultContentPart[];
};

export type ToolExecutionSummarizer = (
  input: ToolExecutionSummaryInput,
) => string;

export type RegisteredTool = {
  definition: ToolDefinition;
  execute: ToolHandler;
  /** Optional one-line English summary of what ran and the outcome. */
  summarizeExecution?: ToolExecutionSummarizer;
};

/** Composer / UI permission state used by the gate. */
export type PermissionGateState = {
  cocoShell?: ToolExecuteContext["cocoShell"];
  cocoMcpCall?: ToolExecuteContext["cocoMcpCall"];
  cocoProjectPath?: ToolExecuteContext["cocoProjectPath"];
  beforeToolExecute?: (name: string, args: JsonObject) => void;
  authorizeTool?: (name: string, args: JsonObject) => void;
  assertPath?: (path: string) => void;
  fullPermissionsEnabled: boolean;
  /**
   * CoCo-supervised turns: Shell high-risk (Class B) findings route to
   * confirmation even under Bypass, so the supervisor reviews them.
   */
  reviewHighRisk?: boolean;
  /**
   * True on headless (Loops daemon) turns — asks never wait for a renderer
   * and settle immediately as cancelled.
   */
  headless?: boolean;
  /**
   * Flip full permissions on for the rest of this turn.
   * Mutates {@link fullPermissionsEnabled}; subsequent level-1 checks see it.
   */
  enableFullPermissions: () => void;
  /**
   * For level-2 tools: return whether the user approved this specific invocation.
   * Async so UI prompts can be awaited later.
   */
  requestConfirmation: (input: {
    toolName: string;
    arguments: JsonObject;
    /** Shell Safe Mode risk context — absent for plain level-2 asks. */
    risk?: ToolApprovalRisk;
    source?: ToolConfirmationSource;
  }) => Promise<boolean>;
  /**
   * For ask_user: present choices and wait for selection / custom text.
   * `options` may be empty — open-ended ask with a free-form input only.
   */
  requestUserAsk: (input: {
    toolCallId: string;
    question: string;
    options: string[];
    optionDetails?: import("../shared/askUser.js").UserAskOption[];
    allowCustom: boolean;
    allowMultiple?: boolean;
    assistantMessageId?: string;
    remainingToolCallIds?: string[];
  }) => Promise<UserAskAnswer | null>;
};
