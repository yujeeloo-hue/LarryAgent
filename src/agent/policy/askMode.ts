
import { isToolNamePermitted } from "./toolNameLists.js";
import { SHELL_TOOL_NAME } from "../../tools/shellToolName.js";

export const ASK_MODE_DENYLIST: readonly string[] = [
  "write_file",
  "patch",
  "convert_to_pdf",
  SHELL_TOOL_NAME,
  "capture_app_window",
  "computer_system",
  "computer_mouse",
  "computer_keyboard",
  "computer_ui",
  "computer_screen",
  "computer_handoff",
  "computer_batch",
  "generate_image",
  "create_plan",
  "update_plan",
  "complete_plan",
  "write_plan_doc",
  "adopt_plan_doc",
  "report_step_blocked",
  "fsm_route",
  "create_skill",
  "update_skill",
  "delete_skill",
  "write_skill_file",
  "patch_skill",
  "merge_skills",
  "deprecate_skill",
  "install_skill",
  "write_knowledge",
  "patch_knowledge",
  "delete_knowledge",
  "update_user_memory",
  "update_project_memory",
  "dispatch_subagent",
  "await_subagent",
  "get_subagent_status",
  "list_subagents",
  "stop_subagent",
  "subagent_batch_result",
  "create_mcp_server",
  "update_mcp_server",
  "delete_mcp_server",
  "request_full_permissions",
] as const;

export const ASK_MODE_DENYLIST_SET: ReadonlySet<string> = new Set(
  ASK_MODE_DENYLIST,
);

export const ASK_MODE_BUILTIN_ALLOWLIST: readonly string[] = [
  "read_file",
  "list_dir",
  "grep",
  "glob",
  "read_skill",
  "search_skills",
  "search_knowledge",
  "read_knowledge",
  "read_user_memory",
  "read_project_memory",
  "read_image",
  "display_image",
  "display_pdf",
  "search_session_history",
  "get_workspace_path",
  "get_current_time",
  "batch_search",
  "unreal_editor_find_references",
  "search_tools",
  "tool_describe",
  "tool_call",
  "ask_user",
] as const;

export const ASK_MODE_MCP_READ_ONLY_SERVER_IDS: readonly string[] = [
  "jnote",
  "tavily",
];

export const ASK_MODE_ALLOW_TOOL_PATTERNS: readonly string[] = [
  ...ASK_MODE_BUILTIN_ALLOWLIST,
  "mcp__tavily__*",
  "mcp__jnote__list_*",
  "mcp__jnote__search_*",
  "mcp__jnote__get_*",
];

export function isAskModeMcpToolAllowed(name: string): boolean {
  if (!name.startsWith("mcp__")) return false;
  const rest = name.slice("mcp__".length);
  const serverId = rest.split("__", 1)[0] ?? "";
  if (!ASK_MODE_MCP_READ_ONLY_SERVER_IDS.includes(serverId)) return false;
  if (serverId === "tavily") return true;
  const toolName = rest.slice(serverId.length + 2).toLowerCase();
  return (
    toolName.startsWith("list_") ||
    toolName.startsWith("search_") ||
    toolName.startsWith("get_")
  );
}

export function isAskModeToolAllowed(name: string): boolean {
  return isToolNamePermitted(name, {
    allowTools: ASK_MODE_ALLOW_TOOL_PATTERNS,
  });
}
