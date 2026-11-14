/**
 * Ask mode (read-only Q&A) tool policy constants.
 *
 * Ask graphs wire these into NodeActionPrepareTools `allowTools`
 * (and DisableTools denylist) — no askMode flag on those actions.
 * RunTools picks up the allowlist from nodeContext after PrepareTools.
 * Default-deny: only patterns in {@link ASK_MODE_ALLOW_TOOL_PATTERNS} may run.
 */

import { isToolNamePermitted } from "./toolNameLists.js";
import { SHELL_TOOL_NAME } from "../../tools/shellToolName.js";

/**
 * Explicit denylist for Ask mode — every mutating / executing / management
 * builtin tool, plus forced-offer metas that are pointless (or dangerous) in
 * a read-only turn. Applied via NodeActionDisableTools in the Ask graph so
 * even globally-forced tools (request_full_permissions, write_plan_doc) are
 * removed from the offer set.
 */
export const ASK_MODE_DENYLIST: readonly string[] = [
  // File / data mutation
  "write_file",
  "patch",
  "convert_to_pdf",
  // Single platform name (exec_command on Windows) — this list is
  // prompt-serialized via sampleGraphs, so macOS output stays identical.
  SHELL_TOOL_NAME,
  "capture_app_window",
  // External paid call + writes an image into the workspace
  "generate_image",
  // Plan machinery (writes docs/plans/ + step state)
  "create_plan",
  "update_plan",
  "complete_plan",
  "write_plan_doc",
  "adopt_plan_doc",
  "report_step_blocked",
  "fsm_route",
  // Skill lifecycle (writes skill files)
  "create_skill",
  "update_skill",
  "delete_skill",
  "write_skill_file",
  "patch_skill",
  "merge_skills",
  "deprecate_skill",
  "install_skill",
  // Memory extraction (writes user / project memory)
  "update_user_memory",
  "update_project_memory",
  // Subagent orchestration (children may execute anything)
  "dispatch_subagent",
  "await_subagent",
  "get_subagent_status",
  "list_subagents",
  "stop_subagent",
  "subagent_batch_result",
  // MCP server management
  "create_mcp_server",
  "update_mcp_server",
  "delete_mcp_server",
  // Forced-offer metas that must NOT surface in Ask
  "request_full_permissions",
] as const;

export const ASK_MODE_DENYLIST_SET: ReadonlySet<string> = new Set(
  ASK_MODE_DENYLIST,
);

/**
 * Builtin tools allowed in Ask mode. Everything not in this set (and not an
 * allowed MCP tool) is rejected by {@link isAskModeToolAllowed}.
 */
export const ASK_MODE_BUILTIN_ALLOWLIST: readonly string[] = [
  // Local read
  "read_file",
  "list_dir",
  "grep",
  "glob",
  "read_skill",
  "search_skills",
  "read_user_memory",
  "read_project_memory",
  "read_image",
  "display_image",
  "display_pdf",
  "search_session_history",
  "get_workspace_path",
  "get_current_time",
  // Local multi-grep (not web search — Tavily MCP covers that)
  "batch_search",
  // Meta (read-only discovery + bridge)
  "search_tools",
  "tool_describe",
  "tool_call",
  "ask_user",
] as const;

/**
 * MCP servers whose tools may run in Ask mode.
 * - `jnote`: only list_ / search_ / get_ tools (write tools stay denied)
 * - `tavily`: entire server (search / extract / research — all read-only web)
 */
export const ASK_MODE_MCP_READ_ONLY_SERVER_IDS: readonly string[] = [
  "jnote",
  "tavily",
];

/**
 * Allow/deny patterns for Ask builtin graphs (PrepareTools + RunTools
 * `allowTools`). Exact builtin names plus MCP globs for Tavily / JNote reads.
 */
export const ASK_MODE_ALLOW_TOOL_PATTERNS: readonly string[] = [
  ...ASK_MODE_BUILTIN_ALLOWLIST,
  "mcp__tavily__*",
  "mcp__jnote__list_*",
  "mcp__jnote__search_*",
  "mcp__jnote__get_*",
];

/**
 * Allow read-only MCP tools.
 * Server id must be in {@link ASK_MODE_MCP_READ_ONLY_SERVER_IDS}.
 * JNote keeps a verb-prefix filter; Tavily allows every tool on that server.
 */
export function isAskModeMcpToolAllowed(name: string): boolean {
  if (!name.startsWith("mcp__")) return false;
  const rest = name.slice("mcp__".length);
  const serverId = rest.split("__", 1)[0] ?? "";
  if (!ASK_MODE_MCP_READ_ONLY_SERVER_IDS.includes(serverId)) return false;
  // Tavily MCP is web lookup only — no write surface to filter.
  if (serverId === "tavily") return true;
  const toolName = rest.slice(serverId.length + 2).toLowerCase();
  return (
    toolName.startsWith("list_") ||
    toolName.startsWith("search_") ||
    toolName.startsWith("get_")
  );
}

/**
 * Master Ask-mode allow predicate (tests / helpers).
 * Same rules as {@link ASK_MODE_ALLOW_TOOL_PATTERNS} on PrepareTools / RunTools.
 */
export function isAskModeToolAllowed(name: string): boolean {
  return isToolNamePermitted(name, {
    allowTools: ASK_MODE_ALLOW_TOOL_PATTERNS,
  });
}
