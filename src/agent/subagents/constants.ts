import type { SubagentRole } from "./types.js";
import { SHELL_TOOL_NAMES } from "../../tools/shellToolName.js";

export const MAX_CONCURRENT_SUBAGENTS = 4;
export const MAX_SUBAGENTS_PER_TURN = 8;
export const MAX_SUBAGENT_MODEL_ITERATIONS = 16;
export const SUBAGENT_SUMMARY_MAX_CHARS = 4000;

/**
 * Default / minimum await_subagent wait (ms).
 * Models often passed 120s; that aborted long explore workers — floor is 2× that.
 */
export const SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS = 240_000;

/** Default / clamp range for dispatch_subagent `priority` (higher starts sooner). */
export const SUBAGENT_PRIORITY_DEFAULT = 50;
export const SUBAGENT_PRIORITY_MIN = 0;
export const SUBAGENT_PRIORITY_MAX = 100;

/** Hard caps on structured subagent result payload (parent-facing, by characters). */
export const SUBAGENT_MAX_ATTACHMENTS = 8;
export const SUBAGENT_MAX_ATTACHMENT_NOTE_CHARS = 200;
/** Max JSON size for the whole `attachment` array (soft char budget). */
export const SUBAGENT_MAX_ATTACHMENT_PAYLOAD_CHARS = 4000;
export const SUBAGENT_MAX_TABLES = 4;
export const SUBAGENT_MAX_TABLE_COLS = 12;
export const SUBAGENT_MAX_TABLE_ROWS = 40;
export const SUBAGENT_MAX_TABLE_CELL_CHARS = 200;
export const SUBAGENT_MAX_TABLE_TITLE_CHARS = 120;
/** Max JSON size for the whole `table` array (soft char budget). */
export const SUBAGENT_MAX_TABLE_PAYLOAD_CHARS = 8000;

/** Live monitor (`subagent_live`) text flush throttle, per run. */
export const SUBAGENT_LIVE_TEXT_FLUSH_MS = 120;
/** Hard cap for one flushed `subagent_live` delta payload (characters). */
export const SUBAGENT_LIVE_MAX_TEXT_CHARS = 6000;
/** Hard cap for a tool-line summary in `subagent_live` (characters). */
export const SUBAGENT_LIVE_TOOL_SUMMARY_CHARS = 300;

/**
 * Tools never offered / never bridge-invokable on any subagent
 * (management + global mutation + parent-only UX).
 * Bridge metas (search_tools / tool_describe / tool_call) are allowed.
 */
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
  "fsm_graph",
  "fsm_graph_edit",
  "turn_handoff",
]);

/**
 * Explore role: deny known-dangerous / mutating builtins (and management).
 * MCP is NOT blanket-banned — reachable via tool_call bridge.
 */
export const EXPLORE_DANGER_DENYLIST = new Set<string>([
  ...SUBAGENT_TOOL_DENYLIST,
  "write_file",
  "patch",
  // Every historical shell-tool name (run_shell / exec_command) — a bridge
  // or stored row may carry either name regardless of the local platform.
  ...SHELL_TOOL_NAMES,
  "convert_to_pdf",
  "capture_app_window",
]);

/**
 * Eager tools[] for explore (lean read set + bridges).
 * Deferred tools (incl. MCP) use search_tools → tool_describe → tool_call.
 */
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

/** Integer priority 0–100; invalid / omitted → default 50. */
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
