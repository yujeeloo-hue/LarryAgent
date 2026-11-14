/** Plan-mode investigation and read-only Direct Q&A policy. */
import { ASK_MODE_DENYLIST } from "./askMode.js";

export const FSM_ROUTE_TOOL_NAME = "fsm_route";

/** Mutating / plan-machinery tools the analyser must not see. */
export const ANALYSER_DENYLIST: readonly string[] = [
  "write_file",
  "patch",
  "convert_to_pdf",
  "capture_app_window",
  "create_plan",
  "update_plan",
  "complete_plan",
  "write_plan_doc",
  "report_step_blocked",
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
  "create_mcp_server",
  "update_mcp_server",
  "delete_mcp_server",
  "request_full_permissions",
];

/** Direct is only for read-only answers. Development stays on the document lane. */
export const PLAN_DIRECT_DENYLIST: readonly string[] = [...ASK_MODE_DENYLIST];
