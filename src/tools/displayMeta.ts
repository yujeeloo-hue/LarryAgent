import type { BuiltinToolName } from "./types.js";

export type ToolIconId =
  | "read_file"
  | "create_workspace"
  | "rename_workspace"
  | "write_file"
  | "patch"
  | "legacy_append_file"
  | "legacy_edit_file"
  | "run_shell"
  | "upload_files"
  | "list_dir"
  | "grep"
  | "glob"
  | "symbols"
  | "batch_search"
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
  | "debug_run"
  | "debug_breakpoints"
  | "debug_step"
  | "debug_inspect"
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
  | "loops"
  | "notify"
  | "unknown";

export type ToolDisplayMeta = {
  displayName: string;
  iconId: ToolIconId;
  expandResultByDefault: boolean;
};

export type LegacyToolName = "append_file" | "edit_file";

const META: Record<BuiltinToolName | LegacyToolName, ToolDisplayMeta> = {
  read_file: {
    displayName: "Read File",
    iconId: "read_file",
    expandResultByDefault: false,
  },
  create_workspace: {
    displayName: "Create Workspace",
    iconId: "create_workspace",
    expandResultByDefault: false,
  },
  rename_workspace: {
    displayName: "Rename Workspace",
    iconId: "rename_workspace",
    expandResultByDefault: false,
  },
  write_file: {
    displayName: "Write File",
    iconId: "write_file",
    expandResultByDefault: true,
  },
  dev_tasks: {
    displayName: "Dev Tasks",
    iconId: "write_file",
    expandResultByDefault: false,
  },
  collaborative_branch: { displayName: "Collaborative Branch", iconId: "write_file", expandResultByDefault: false },
  run_dev_task: {
    displayName: "Run Dev Task",
    iconId: "run_shell",
    expandResultByDefault: false,
  },
  debug_run: {
    displayName: "Debug Run",
    iconId: "debug_run",
    expandResultByDefault: false,
  },
  debug_breakpoints: {
    displayName: "Debug Breakpoints",
    iconId: "debug_breakpoints",
    expandResultByDefault: false,
  },
  debug_step: {
    displayName: "Debug Step",
    iconId: "debug_step",
    expandResultByDefault: false,
  },
  debug_inspect: {
    displayName: "Debug Inspect",
    iconId: "debug_inspect",
    expandResultByDefault: false,
  },
  patch: {
    displayName: "Patch",
    iconId: "patch",
    expandResultByDefault: true,
  },
  append_file: {
    displayName: "Append File",
    iconId: "legacy_append_file",
    expandResultByDefault: true,
  },
  edit_file: {
    displayName: "Edit File",
    iconId: "legacy_edit_file",
    expandResultByDefault: true,
  },
  run_shell: {
    displayName: "Shell",
    iconId: "run_shell",
    expandResultByDefault: false,
  },
  exec_command: {
    displayName: "Shell",
    iconId: "run_shell",
    expandResultByDefault: false,
  },
  upload_files: {
    displayName: "Upload Files",
    iconId: "upload_files",
    expandResultByDefault: false,
  },
  list_dir: {
    displayName: "List Directory",
    iconId: "list_dir",
    expandResultByDefault: false,
  },
  get_workspace_path: {
    displayName: "Workspace Path",
    iconId: "get_workspace_path",
    expandResultByDefault: true,
  },
  get_current_time: {
    displayName: "Current Time",
    iconId: "get_current_time",
    expandResultByDefault: true,
  },
  grep: {
    displayName: "Search",
    iconId: "grep",
    expandResultByDefault: false,
  },
  glob: {
    displayName: "Find Files",
    iconId: "glob",
    expandResultByDefault: false,
  },
  symbols: {
    displayName: "Symbols",
    iconId: "symbols",
    expandResultByDefault: false,
  },
  batch_search: {
    displayName: "Batch Search",
    iconId: "batch_search",
    expandResultByDefault: false,
  },
  find_cxx_references: {
    displayName: "C++ References",
    iconId: "symbols",
    expandResultByDefault: false,
  },
  unreal_editor_find_references: {
    displayName: "Blueprint References",
    iconId: "symbols",
    expandResultByDefault: false,
  },
  unreal_editor_open: {
    displayName: "Open in Unreal",
    iconId: "read_file",
    expandResultByDefault: false,
  },
  ask_user: {
    displayName: "Ask User",
    iconId: "ask_user",
    expandResultByDefault: true,
  },
  request_full_permissions: {
    displayName: "Bypass Permissions",
    iconId: "request_full_permissions",
    expandResultByDefault: true,
  },
  search_tools: {
    displayName: "Search Tools",
    iconId: "search_tools",
    expandResultByDefault: false,
  },
  tool_describe: {
    displayName: "Describe Tool",
    iconId: "tool_describe",
    expandResultByDefault: true,
  },
  tool_call: {
    displayName: "Call Tool",
    iconId: "tool_call",
    expandResultByDefault: false,
  },
  create_plan: {
    displayName: "Create Plan",
    iconId: "create_plan",
    expandResultByDefault: false,
  },
  update_plan: {
    displayName: "Update Plan",
    iconId: "update_plan",
    expandResultByDefault: false,
  },
  complete_plan: {
    displayName: "Complete Plan",
    iconId: "complete_plan",
    expandResultByDefault: false,
  },
  fsm_route: {
    displayName: "FSM Route",
    iconId: "fsm_route",
    expandResultByDefault: false,
  },
  fsm_graph_context: {
    displayName: "Graph Context",
    iconId: "fsm_route",
    expandResultByDefault: false,
  },
  fsm_graph_node: {
    displayName: "Graph Node",
    iconId: "fsm_route",
    expandResultByDefault: false,
  },
  fsm_graph_connection: {
    displayName: "Graph Connection",
    iconId: "fsm_route",
    expandResultByDefault: false,
  },
  fsm_graph_action: {
    displayName: "Graph Action",
    iconId: "fsm_route",
    expandResultByDefault: false,
  },
  report_step_blocked: {
    displayName: "Step Blocked",
    iconId: "update_plan",
    expandResultByDefault: true,
  },
  write_plan_doc: {
    displayName: "Write Plan Doc",
    iconId: "write_file",
    expandResultByDefault: true,
  },
  adopt_plan_doc: {
    displayName: "Adopt Plan Doc",
    iconId: "read_file",
    expandResultByDefault: false,
  },
  read_image: {
    displayName: "Read Image",
    iconId: "read_image",
    expandResultByDefault: true,
  },
  display_image: {
    displayName: "Display Image",
    iconId: "read_image",
    expandResultByDefault: false,
  },
  generate_image: {
    displayName: "Generate Image",
    iconId: "generate_image",
    expandResultByDefault: false,
  },
  capture_app_window: {
    displayName: "Capture App Window",
    iconId: "capture_app_window",
    expandResultByDefault: false,
  },
  computer_system: {
    displayName: "Computer System",
    iconId: "computer_system",
    expandResultByDefault: false,
  },
  computer_mouse: {
    displayName: "Computer Mouse",
    iconId: "computer_mouse",
    expandResultByDefault: false,
  },
  computer_keyboard: {
    displayName: "Computer Keyboard",
    iconId: "computer_keyboard",
    expandResultByDefault: false,
  },
  computer_ui: {
    displayName: "Computer UI",
    iconId: "computer_ui",
    expandResultByDefault: false,
  },
  computer_screen: {
    displayName: "Computer Screen",
    iconId: "computer_screen",
    expandResultByDefault: false,
  },
  computer_handoff: {
    displayName: "Hand Off to User",
    iconId: "computer_handoff",
    expandResultByDefault: true,
  },
  computer_batch: {
    displayName: "Computer Batch",
    iconId: "computer_batch",
    expandResultByDefault: true,
  },
  convert_to_pdf: {
    displayName: "Convert to PDF",
    iconId: "convert_to_pdf",
    expandResultByDefault: true,
  },
  display_pdf: {
    displayName: "Display PDF",
    iconId: "display_pdf",
    expandResultByDefault: false,
  },
  present_demo: {
    displayName: "Present Demo",
    iconId: "present_demo",
    expandResultByDefault: true,
  },
  create_mcp_server: {
    displayName: "Create MCP",
    iconId: "create_mcp_server",
    expandResultByDefault: true,
  },
  update_mcp_server: {
    displayName: "Update MCP",
    iconId: "update_mcp_server",
    expandResultByDefault: true,
  },
  delete_mcp_server: {
    displayName: "Delete MCP",
    iconId: "delete_mcp_server",
    expandResultByDefault: true,
  },
  create_skill: {
    displayName: "Create Skill",
    iconId: "create_skill",
    expandResultByDefault: true,
  },
  update_skill: {
    displayName: "Update Skill",
    iconId: "update_skill",
    expandResultByDefault: true,
  },
  delete_skill: {
    displayName: "Delete Skill",
    iconId: "delete_skill",
    expandResultByDefault: true,
  },
  read_skill: {
    displayName: "Read Skill",
    iconId: "read_skill",
    expandResultByDefault: false,
  },
  search_skills: {
    displayName: "Search Skills",
    iconId: "search_skills",
    expandResultByDefault: false,
  },
  search_knowledge: {
    displayName: "Search Knowledge",
    iconId: "search_knowledge",
    expandResultByDefault: false,
  },
  read_knowledge: {
    displayName: "Read Knowledge",
    iconId: "read_knowledge",
    expandResultByDefault: false,
  },
  write_knowledge: {
    displayName: "Write Knowledge",
    iconId: "write_knowledge",
    expandResultByDefault: true,
  },
  patch_knowledge: {
    displayName: "Patch Knowledge",
    iconId: "patch_knowledge",
    expandResultByDefault: true,
  },
  delete_knowledge: {
    displayName: "Delete Knowledge",
    iconId: "delete_knowledge",
    expandResultByDefault: true,
  },
  write_skill_file: {
    displayName: "Write Skill File",
    iconId: "write_skill_file",
    expandResultByDefault: true,
  },
  patch_skill: {
    displayName: "Patch Skill",
    iconId: "patch_skill",
    expandResultByDefault: false,
  },
  merge_skills: {
    displayName: "Merge Skills",
    iconId: "merge_skills",
    expandResultByDefault: false,
  },
  deprecate_skill: {
    displayName: "Deprecate Skill",
    iconId: "deprecate_skill",
    expandResultByDefault: false,
  },
  install_skill: {
    displayName: "Install Skill",
    iconId: "install_skill",
    expandResultByDefault: true,
  },
  read_user_memory: {
    displayName: "Read User Memory",
    iconId: "read_user_memory",
    expandResultByDefault: false,
  },
  update_user_memory: {
    displayName: "Update User Memory",
    iconId: "update_user_memory",
    expandResultByDefault: true,
  },
  read_project_memory: {
    displayName: "Read Project Memory",
    iconId: "read_project_memory",
    expandResultByDefault: false,
  },
  update_project_memory: {
    displayName: "Update Project Memory",
    iconId: "update_project_memory",
    expandResultByDefault: true,
  },
  search_session_history: {
    displayName: "Session History",
    iconId: "search_session_history",
    expandResultByDefault: false,
  },
  dispatch_subagent: {
    displayName: "Dispatch Subagent",
    iconId: "dispatch_subagent",
    expandResultByDefault: false,
  },
  await_subagent: {
    displayName: "Await Subagent",
    iconId: "await_subagent",
    expandResultByDefault: true,
  },
  subagent_batch_result: {
    displayName: "Subagent Batch",
    iconId: "subagent_batch_result",
    expandResultByDefault: true,
  },
  get_subagent_status: {
    displayName: "Subagent Status",
    iconId: "get_subagent_status",
    expandResultByDefault: true,
  },
  list_subagents: {
    displayName: "List Subagents",
    iconId: "list_subagents",
    expandResultByDefault: true,
  },
  stop_subagent: {
    displayName: "Stop Subagent",
    iconId: "stop_subagent",
    expandResultByDefault: true,
  },
  loops: {
    displayName: "Loops",
    iconId: "loops",
    expandResultByDefault: false,
  },
  notify: {
    displayName: "Notify",
    iconId: "notify",
    expandResultByDefault: false,
  },
};

const UNKNOWN: ToolDisplayMeta = {
  displayName: "Tool",
  iconId: "unknown",
  expandResultByDefault: false,
};

export function getToolDisplayMeta(name: string): ToolDisplayMeta {
  if (name === "coco_work") return { displayName:"Update work",iconId:"create_plan",expandResultByDefault:false };
  if (name === "coco_memory") return { displayName:"Update CoCo memory",iconId:"update_project_memory",expandResultByDefault:false };
  if (name === "coco_workspace") return { displayName:"Create workspace",iconId:"create_plan",expandResultByDefault:false };
  if (name === "coco_balance") return { displayName:"Check balance",iconId:"search_session_history",expandResultByDefault:false };
  if (name === "coco_plan_goal") return {displayName:"Plan goal in background",iconId:"create_plan",expandResultByDefault:false};
  if (name === "coco_context") return { displayName:"Review work context",iconId:"search_session_history",expandResultByDefault:false };
  if (name === "coco_job_input") return { displayName:"Read task evidence",iconId:"read_file",expandResultByDefault:false };
  if (name === "read_coco_context") return { displayName:"Read project context",iconId:"search_session_history",expandResultByDefault:false };
  if (name === "submit_coco_result") return { displayName:"Save check result",iconId:"create_plan",expandResultByDefault:false };
  if (name === "coco_submit_plan") return { displayName:"Save work plan",iconId:"create_plan",expandResultByDefault:false };
  if (Object.prototype.hasOwnProperty.call(META, name)) {
    return META[name as BuiltinToolName];
  }
  return {
    ...UNKNOWN,
    displayName: name || UNKNOWN.displayName,
  };
}

export function toolRunningProgressText(toolName: string): string {
  switch (toolName) {
    case "create_workspace":
      return "Creating workspace…";
    case "rename_workspace":
      return "Renaming workspace…";
    case "write_file":
    case "write_skill_file":
      return "Writing file…";
    case "patch":
      return "Patching…";
    case "append_file":
    case "edit_file":
      return "Editing file…";
    case "convert_to_pdf":
      return "Converting to PDF…";
    case "read_file":
    case "read_skill":
    case "read_knowledge":
    case "read_user_memory":
    case "read_project_memory":
      return "Reading…";
    case "search_session_history":
      return "Searching session history…";
    case "read_image":
      return "Describing image…";
    case "generate_image":
      return "Generating image…";
    case "capture_app_window":
      return "Capturing app window…";
    case "computer_mouse":
      return "Moving the mouse…";
    case "computer_keyboard":
      return "Typing…";
    case "computer_ui":
      return "Looking up UI elements…";
    case "computer_screen":
      return "Reading the screen…";
    case "computer_handoff":
      return "Waiting for you…";
    case "computer_batch":
      return "Running desktop steps…";
    case "display_pdf":
      return "Displaying PDF…";
    case "present_demo":
      return "Presenting demo…";
    case "run_shell":
    case "exec_command":
      return "Executing shell…";
    case "run_dev_task":
      return "Running dev task…";
    case "debug_run":
      return "Debugging…";
    case "debug_breakpoints":
      return "Updating breakpoints…";
    case "debug_step":
      return "Stepping…";
    case "debug_inspect":
      return "Inspecting debug state…";
    case "upload_files":
      return "Uploading…";
    case "grep":
    case "batch_search":
      return "Searching…";
    case "symbols":
      return "Searching symbols…";
    case "glob":
      return "Finding files…";
    case "list_dir":
      return "Listing directory…";
    case "ask_user":
      return "Waiting for your answer…";
    case "request_full_permissions":
      return "Waiting for bypass permissions…";
    case "search_tools":
      return "Searching tools…";
    case "search_skills":
      return "Searching skills…";
    case "search_knowledge":
      return "Searching knowledge…";
    case "write_knowledge":
    case "patch_knowledge":
      return "Updating knowledge…";
    case "tool_describe":
      return "Loading tool schema…";
    case "tool_call":
      return "Calling deferred tool…";
    case "await_subagent":
      return "Waiting for subagent…";
    case "subagent_batch_result":
      return "Waiting for subagent batch…";
    case "dispatch_subagent":
      return "Dispatching subagent…";
    case "create_plan":
    case "update_plan":
    case "complete_plan":
      return "Updating plan…";
    case "write_plan_doc":
      return "Writing plan document…";
    case "adopt_plan_doc":
      return "Reading existing plan document…";
    case "install_skill":
      return "Installing skill…";
    case "create_skill":
    case "update_skill":
    case "delete_skill":
      return `${getToolDisplayMeta(toolName).displayName}…`;
    case "create_mcp_server":
    case "update_mcp_server":
    case "delete_mcp_server":
      return `${getToolDisplayMeta(toolName).displayName}…`;
    default: {
      if (toolName.startsWith("mcp__")) {
        const short = toolName.split("__").pop() || toolName;
        return `Executing ${short}…`;
      }
      return `Executing ${getToolDisplayMeta(toolName).displayName}…`;
    }
  }
}

export function toolPreparingProgressText(toolName: string): string {
  return toolRunningProgressText(toolName);
}

export function toolApprovalProgressText(toolName: string): string {
  return `Waiting for approval: ${getToolDisplayMeta(toolName).displayName}…`;
}

export function toolAskProgressText(toolName: string): string {
  return toolName === "request_full_permissions"
    ? toolRunningProgressText(toolName)
    : toolRunningProgressText("ask_user");
}

export const TOOL_RESULT_BODY_PART_ID = "file_body";

export const TOOL_RESULT_DIFF_PART_ID = "file_diff";
