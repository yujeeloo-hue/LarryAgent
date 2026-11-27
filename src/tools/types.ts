import type { SkillActor, SkillWritePolicy } from "../skills/types.js";
import type { UserAskAnswer } from "../shared/askUser.js";
import type { JsonObject, ToolResultContentPart } from "../session/types.js";
import type { DevTaskRunnerPort } from "./devTaskRunnerPort.js";

export type { JsonObject };

export type PermissionLevel = 0 | 1 | 2;

export type ToolRiskRewrite = {
  type: "trash";
  targets: string[];
  force: boolean;
  originalCommand: string;
};

export type ToolRiskAssessment =
  | { action: "allow"; rewrite?: ToolRiskRewrite }
  | { action: "defer" }
  | {
      action: "confirm";
      fatal: boolean;
      reason: string;
      hint?: string;
      rewrite?: ToolRiskRewrite;
    }
  | { action: "block"; reason: string; hint?: string };

export type ToolRiskAssessor = (input: {
  arguments: JsonObject;
  fullPermissionsEnabled: boolean;
  reviewHighRisk?: boolean;
  workspacePath?: string;
}) => ToolRiskAssessment;

export type ToolApprovalRisk = {
  fatal: boolean;
  reason: string;
  trashRewrite: boolean;
};

export type ToolConfirmationSource = "ask_level" | "shell_risk" | "hook_ask";

export type BuiltinToolName =
  | "read_file"
  | "create_workspace"
  | "rename_workspace"
  | "write_file"
  | "patch"
  | "run_shell"
  | "exec_command"
  | "upload_files"
  | "list_dir"
  | "grep"
  | "glob"
  | "symbols"
  | "batch_search"
  | "find_cxx_references"
  | "unreal_editor_find_references"
  | "unreal_editor_open"
  | "debug_run"
  | "debug_breakpoints"
  | "debug_step"
  | "debug_inspect"
  | "ask_user"
  | "request_full_permissions"
  | "search_tools"
  | "tool_describe"
  | "tool_call"
  | "read_image"
  | "display_image"
  | "generate_image"
  | "capture_app_window"
  | "computer_system"
  | "computer_mouse"
  | "computer_keyboard"
  | "computer_ui"
  | "computer_screen"
  | "computer_handoff"
  | "computer_batch"
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
  | "patch_skill"
  | "merge_skills"
  | "deprecate_skill"
  | "install_skill"
  | "search_knowledge"
  | "read_knowledge"
  | "write_knowledge"
  | "patch_knowledge"
  | "delete_knowledge"
  | "create_plan"
  | "update_plan"
  | "complete_plan"
  | "fsm_route"
  | "fsm_graph_context"
  | "fsm_graph_node"
  | "fsm_graph_connection"
  | "fsm_graph_action"
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
  | "dev_tasks"
  | "collaborative_branch"
  | "run_dev_task"
  | "loops"
  | "notify";

export type ToolName = BuiltinToolName | (string & {});

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonObject;
  validationParameters?: JsonObject;
  defaultPermissionLevel: PermissionLevel;
  assessRisk?: ToolRiskAssessor;
};

export type { UserAskAnswer } from "../shared/askUser.js";

export type VisionClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  rawEndpoint?: boolean;
  apiProtocol?: import("../llm/apiProtocol.js").LlmApiProtocol;
};

export type ImageGenClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  rawEndpoint?: boolean;
  watermark?: boolean;
  imageInput?: "base64" | "url";
};

export type DesktopPasswordTarget = {
  destination: import("../shared/askUser.js").HandoffPasswordDestination;
  login?: { origin: string; account?: string };
  fill: (password: string, signal?: AbortSignal, login?: { account: string; requireAccountField?: boolean }) => Promise<boolean>;
};

export type UserAskRequestInput = {
  question: string;
  detail?: string;
  options: string[];
  optionDetails?: import("../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple?: boolean;
  assistantMessageId?: string;
  remainingToolCallIds?: string[];
  signal?: AbortSignal;
  keepDesktop?: boolean;
  suppressChime?: boolean;
  handoffQrPng?: string;
  desktopPassword?: DesktopPasswordTarget;
};

export type ToolExecuteContext = {
  cocoProjectPath?: (workspaceId: string) => string;
  devTaskRunner?: DevTaskRunnerPort;
  workspaceManager?: import("./workspaceManagerPort.js").WorkspaceManagerPort;
  debugControl?: import("./debugControlPort.js").DebugControlPort;
  cocoShell?: (input: import("./shellExec.js").ShellExecInput) => Promise<import("./shellExec.js").ShellExecResult>;
  cocoMcpCall?: (serverId: string, tool: string, args: JsonObject, signal?: AbortSignal) => Promise<ToolExecuteResult>;
  assertPath?: (path: string) => void;
  workspacePath: string;
  sessionId?: string;
  workspaceId?: string;
  listAgentSessions?: () => import("../session/types.js").Session[];
  fsmGraphLibrary?: import("./fsmGraphAuthoring.js").FsmGraphLibraryPort;
  loops?: import("./loopsTool.js").LoopsToolPort;
  notify?: import("./notifyTool.js").NotifyToolPort;
  listWorkspaces?: () => { id: string; name: string }[];
  listSessionHistory?: () => import("../session/db/sessionHistoryRepository.js").SessionHistoryRecord[];
  fullPermissionsEnabled: boolean;
  planExecutionRequested?: boolean;
  requirePlanDocApprovalForCreatePlan?: boolean;
  headlessMode?: boolean;
  subagentTurn?: boolean;
  signal?: AbortSignal;
  toolCallId?: string;
  enableFullPermissions?: () => void;
  bridgeScope?: {
    allowlist?: ReadonlySet<string>;
    denylist?: ReadonlySet<string>;
  };
  requestUserAsk?: (
    input: UserAskRequestInput,
  ) => Promise<UserAskAnswer | null>;
  trySavedHandoffPassword?: (target: DesktopPasswordTarget, signal?: AbortSignal) => Promise<"filled" | "not-found" | "failed">;
  resetModelIterations?: () => void;
  planSnapshot?: import("../session/types.js").SessionPlan | null;
  planDocSnapshot?: import("../session/types.js").SessionPlanDoc | null;
  requirePlanDocForCreatePlan?: boolean;
  boundRouteEvents?: string[];
  shellStructuredReceipt?: boolean;
  skillActor?: SkillActor;
  skillWritePolicy?: SkillWritePolicy;
  getVisionClient?: () => Promise<VisionClientConfig | null>;
  getImageGenClient?: () => Promise<ImageGenClientConfig | null>;
  uploadImageGenInput?: (
    bytes: Uint8Array,
    mimeType: string,
    ext: string,
  ) => Promise<string>;
  uploadReadImage?: (input: {
    imagePath: string;
    mimeType: string;
  }) => Promise<{ url: string; key: string } | null>;
  subagents?: import("../agent/subagents/types.js").SubagentHost;
  emitLive?: (kind: string, payload: JsonObject) => void;
};

export type ToolExecuteResult = {
  content: ToolResultContentPart[];
  returnCode: number;
  sessionPatch?: import("../agent/contracts/index.js").SessionPatch;
  routeEvent?: import("../agent/contracts/index.js").RouteEventPatch;
  receipt?: JsonObject;
};

export const SKILL_READ_RECEIPT_KIND = "skill_read";
export const SKILL_WRITE_RECEIPT_KIND = "skill_write";

export type ToolHandler = (
  args: JsonObject,
  context: ToolExecuteContext,
) => Promise<ToolExecuteResult>;

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
  summarizeExecution?: ToolExecutionSummarizer;
};

export type PermissionGateState = {
  cocoShell?: ToolExecuteContext["cocoShell"];
  cocoMcpCall?: ToolExecuteContext["cocoMcpCall"];
  cocoProjectPath?: ToolExecuteContext["cocoProjectPath"];
  beforeToolExecute?: (name: string, args: JsonObject) => void;
  authorizeTool?: (name: string, args: JsonObject) => void;
  assertPath?: (path: string) => void;
  fullPermissionsEnabled: boolean;
  reviewHighRisk?: boolean;
  headless?: boolean;
  enableFullPermissions: () => void;
  requestConfirmation: (input: {
    toolName: string;
    arguments: JsonObject;
    risk?: ToolApprovalRisk;
    source?: ToolConfirmationSource;
  }) => Promise<boolean>;
  requestUserAsk: (input: UserAskRequestInput & { toolCallId: string }) => Promise<UserAskAnswer | null>;
  trySavedHandoffPassword?: ToolExecuteContext["trySavedHandoffPassword"];
};
