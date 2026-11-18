import type { SubagentRole } from "./types.js";
import { SHELL_TOOL_NAMES } from "../../tools/shellToolName.js";

export const MAX_CONCURRENT_SUBAGENTS = 4;
export const MAX_SUBAGENTS_PER_TURN = 8;
export const MAX_SUBAGENT_MODEL_ITERATIONS = 16;
export const SUBAGENT_SUMMARY_MAX_CHARS = 4000;

export const SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS = 240_000;

export const SUBAGENT_PRIORITY_DEFAULT = 50;
export const SUBAGENT_PRIORITY_MIN = 0;
export const SUBAGENT_PRIORITY_MAX = 100;

export const SUBAGENT_MAX_ATTACHMENTS = 8;
export const SUBAGENT_MAX_ATTACHMENT_NOTE_CHARS = 200;
export const SUBAGENT_MAX_ATTACHMENT_PAYLOAD_CHARS = 4000;
export const SUBAGENT_MAX_TABLES = 4;
export const SUBAGENT_MAX_TABLE_COLS = 12;
export const SUBAGENT_MAX_TABLE_ROWS = 40;
export const SUBAGENT_MAX_TABLE_CELL_CHARS = 200;
export const SUBAGENT_MAX_TABLE_TITLE_CHARS = 120;
export const SUBAGENT_MAX_TABLE_PAYLOAD_CHARS = 8000;

export const SUBAGENT_LIVE_TEXT_FLUSH_MS = 120;
export const SUBAGENT_LIVE_MAX_TEXT_CHARS = 6000;
export const SUBAGENT_LIVE_TOOL_SUMMARY_CHARS = 300;

export const SUBAGENT_TOOL_DENYLIST = new Set<string>([
  "dispatch_subagent",
  "await_subagent",
  "get_subagent_status",
  "list_subagents",
  "stop_subagent",
  "subagent_batch_result",
  "create_mcp_server",
  "update_mcp_server",
  "delete_mcp_server",
  "create_skill",
  "update_skill",
  "delete_skill",
  "write_skill_file",
  "patch_skill",
  "merge_skills",
  "deprecate_skill",
  "install_skill",
  "update_user_memory",
  "update_project_memory",
  "ask_user",
  "request_full_permissions",
  "create_plan",
  "update_plan",
  "complete_plan",
  "write_plan_doc",
  "adopt_plan_doc",
  "report_step_blocked",
  "fsm_route",
  "fsm_graph_context",
  "fsm_graph_node",
  "fsm_graph_connection",
  "fsm_graph_action",
]);

export const EXPLORE_DANGER_DENYLIST = new Set<string>([
  ...SUBAGENT_TOOL_DENYLIST,
  "write_file",
  "patch",
  ...SHELL_TOOL_NAMES,
  "convert_to_pdf",
  "capture_app_window",
]);

export const EXPLORE_EAGER_TOOL_ALLOWLIST = new Set<string>([
  "search_tools",
  "tool_describe",
  "tool_call",
  "read_file",
  "list_dir",
  "grep",
  "glob",
  "batch_search",
  "get_workspace_path",
  "get_current_time",
  "read_skill",
  "search_skills",
  "read_user_memory",
  "read_project_memory",
  "read_image",
  "display_image",
  "display_pdf",
  "search_session_history",
]);

export function normalizeSubagentRole(raw: unknown): SubagentRole {
  if (raw === "explore" || raw === "worker" || raw === "general") {
    return raw;
  }
  return "general";
}

export function normalizeSubagentPriority(raw: unknown): number {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return SUBAGENT_PRIORITY_DEFAULT;
  return Math.min(
    SUBAGENT_PRIORITY_MAX,
    Math.max(SUBAGENT_PRIORITY_MIN, Math.round(n)),
  );
}
