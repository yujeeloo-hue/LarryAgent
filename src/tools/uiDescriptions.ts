import type { BuiltinToolName } from "./types.js";

/** Human-facing copy. Model instructions remain in ToolDefinition.description. */
export const TOOL_UI_DESCRIPTIONS = {
  read_file: "Read the contents of a file.",
  write_file: "Create a file or replace its contents.",
  patch: "Apply targeted changes to existing files.",
  run_shell: "Run commands in the workspace terminal.",
  exec_command: "Run commands in the workspace terminal.",
  upload_files: "Upload local files to a remote destination.",
  list_dir: "Browse files and folders in a directory.",
  grep: "Find matching text in project files.",
  glob: "Find project files by name pattern.",
  symbols: "Find code symbols such as functions and classes.",
  batch_search: "Search for several text patterns at once.",
  find_cxx_references: "Find compiled C++ references via clangd (Unreal).",
  ask_user: "Ask a question with choices or a custom answer, then wait for confirmation.",
  request_full_permissions: "Ask for permission to continue with broader access.",
  search_tools: "Find available tools by name or capability.",
  tool_describe: "Look up a tool's capabilities and inputs.",
  tool_call: "Run an available tool by name.",
  read_image: "Inspect a local image and describe its contents.",
  display_image: "Show an image in the conversation.",
  generate_image: "Create or edit images from a description.",
  capture_app_window: "Capture an application window as an image.",
  convert_to_pdf: "Convert an HTML or Markdown document to PDF.",
  display_pdf: "Open a PDF in the conversation.",
  present_demo: "Show an interactive demo for review and feedback.",
  get_workspace_path: "Show the current workspace folder.",
  get_current_time: "Get the current date and time.",
  create_mcp_server: "Add a connection to an external tool server.",
  update_mcp_server: "Change an external tool server connection.",
  delete_mcp_server: "Remove an external tool server connection.",
  create_skill: "Create a reusable agent skill.",
  update_skill: "Update an existing agent skill.",
  delete_skill: "Delete an agent skill.",
  read_skill: "Read a skill's instructions and supporting resources.",
  search_skills: "Find skills relevant to a task.",
  write_skill_file: "Create or replace a supporting file in a skill.",
  patch_skill: "Fix part of a skill's instructions.",
  merge_skills: "Merge overlapping skills into one.",
  deprecate_skill: "Retire a skill that is wrong or replaced.",
  install_skill: "Install a skill from an available source.",
  create_plan: "Create a step-by-step plan for the task.",
  update_plan: "Update a plan and its progress.",
  complete_plan: "Mark a plan as complete.",
  fsm_route: "Move the task to its next workflow stage.",
  fsm_graph: "View and manage agent workflow graphs.",
  fsm_graph_edit: "Edit the steps and connections in a workflow graph.",
  report_step_blocked: "Report a blocked plan step and explain what is needed.",
  write_plan_doc: "Write or update the task's plan document.",
  adopt_plan_doc: "Use an existing document as the task plan.",
  read_user_memory: "Read saved preferences and personal context.",
  update_user_memory: "Update saved preferences and personal context.",
  read_project_memory: "Read saved knowledge about the project.",
  update_project_memory: "Update saved knowledge about the project.",
  search_session_history: "Find relevant information in earlier conversations.",
  dispatch_subagent: "Assign part of the task to another agent.",
  await_subagent: "Wait for another agent to finish its work.",
  subagent_batch_result: "Collect results from a group of agents.",
  get_subagent_status: "Check another agent's progress and status.",
  list_subagents: "View the agents working on the current task.",
  stop_subagent: "Stop an agent's current work.",
  turn_handoff: "Pass the task to the next workflow stage.",
  dev_tasks: "Configure the Dev Mode build, run and deploy buttons.",
  run_dev_task: "Build, run or deploy a workspace using its Dev Mode tasks.",
  loops: "Create and manage recurring tasks.",
  notify: "Show a desktop notification.",
} satisfies Record<BuiltinToolName, string>;

export function getToolUiDescription(name: string): string {
  return Object.hasOwn(TOOL_UI_DESCRIPTIONS, name)
    ? TOOL_UI_DESCRIPTIONS[name as BuiltinToolName]
    : "Tool available in this workspace.";
}

/** MCP supplies model instructions, so build neutral UI copy from its label. */
export function getMcpToolUiDescription(toolName: string, serverName: string): string {
  const label = toolName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  const action = label ? label[0]!.toUpperCase() + label.slice(1) : "Use this tool";
  return `${action} with ${serverName}.`;
}
