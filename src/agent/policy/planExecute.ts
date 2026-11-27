import { ASK_MODE_DENYLIST } from "./askMode.js";

export const FSM_ROUTE_TOOL_NAME = "fsm_route";

export const ANALYSER_DENYLIST: readonly string[] = [
  "write_file",
  "patch",
  "convert_to_pdf",
  "capture_app_window",
  "computer_system",
  "computer_mouse",
  "computer_keyboard",
  "computer_ui",
  "computer_screen",
  "computer_handoff",
  "computer_batch",
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
  "write_knowledge",
  "patch_knowledge",
  "delete_knowledge",
  "update_user_memory",
  "update_project_memory",
  "create_mcp_server",
  "update_mcp_server",
  "delete_mcp_server",
  "request_full_permissions",
];

export const PLAN_DIRECT_DENYLIST: readonly string[] = [...ASK_MODE_DENYLIST];
