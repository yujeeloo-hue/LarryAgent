import type { BuiltinToolName, PermissionLevel } from "./types.js";

export type ToolCategoryId =
  | "filesystem"
  | "search"
  | "shell"
  | "development"
  | "interaction"
  | "orchestration"
  | "fsm-graph"
  | "vision"
  | "computer-use"
  | "mcp"
  | "skills"
  | "knowledge"
  | "memory";

export type ToolCategory = {
  id: ToolCategoryId;
  label: string;
  description: string;
};

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: "filesystem",
    label: "Filesystem",
    description: "Read and change files and directories, and create or rename project workspaces.",
  },
  {
    id: "search",
    label: "Search",
    description: "Find text and patterns across the project.",
  },
  {
    id: "shell",
    label: "Shell",
    description: "Run terminal commands.",
  },
  {
    id: "development",
    label: "Development",
    description: "Configure and execute build, run and deploy tasks, debug a running project (breakpoints, stepping, stack and variables), explore code symbols, and find C++ references.",
  },
  {
    id: "interaction",
    label: "Interaction",
    description: "Ask the user questions and manage multi-step plans.",
  },
  {
    id: "orchestration",
    label: "Orchestration",
    description: "Dispatch, await, and manage parallel subagents.",
  },
  {
    id: "fsm-graph",
    label: "FSM Graph",
    description: "Build graph drafts step by step, configure nodes and actions, and validate before enabling.",
  },
  {
    id: "vision",
    label: "Vision",
    description: "Understand local images with a vision-capable model.",
  },
  {
    id: "computer-use",
    label: "Computer Use",
    description:
      "Operate the desktop on macOS and Windows: ordered batches, mouse and keyboard input, accessibility lookup, screenshots and OCR.",
  },
  {
    id: "mcp",
    label: "MCP",
    description: "Create, update, and delete MCP server connections.",
  },
  {
    id: "skills",
    label: "Skills",
    description: "Create, update, delete, and read agent skills.",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    description: "Search, read, and maintain the agent's internal knowledge base.",
  },
  {
    id: "memory",
    label: "Memory",
    description:
      "User profile, project memory, and workspace conversation history.",
  },
];

export const TOOL_CATEGORY_BY_NAME: Record<BuiltinToolName, ToolCategoryId> = {
  read_file: "filesystem",
  create_workspace: "filesystem",
  rename_workspace: "filesystem",
  write_file: "filesystem",
  dev_tasks: "development",
  collaborative_branch: "development",
  debug_run: "development",
  debug_breakpoints: "development",
  debug_step: "development",
  debug_inspect: "development",
  patch: "filesystem",
  list_dir: "filesystem",
  get_workspace_path: "filesystem",
  get_current_time: "interaction",
  grep: "search",
  glob: "search",
  symbols: "development",
  batch_search: "search",
  find_cxx_references: "development",
  unreal_editor_find_references: "development",
  unreal_editor_open: "development",
  run_shell: "shell",
  exec_command: "shell",
  run_dev_task: "development",
  upload_files: "shell",
  ask_user: "interaction",
  request_full_permissions: "interaction",
  search_tools: "interaction",
  tool_describe: "interaction",
  tool_call: "interaction",
  create_plan: "interaction",
  write_plan_doc: "interaction",
  adopt_plan_doc: "interaction",
  update_plan: "interaction",
  complete_plan: "interaction",
  fsm_route: "interaction",
  fsm_graph_context: "fsm-graph",
  fsm_graph_node: "fsm-graph",
  fsm_graph_connection: "fsm-graph",
  fsm_graph_action: "fsm-graph",
  report_step_blocked: "interaction",
  dispatch_subagent: "orchestration",
  await_subagent: "orchestration",
  subagent_batch_result: "orchestration",
  get_subagent_status: "orchestration",
  list_subagents: "orchestration",
  stop_subagent: "orchestration",
  loops: "orchestration",
  notify: "interaction",
  present_demo: "interaction",
  read_image: "vision",
  display_image: "vision",
  generate_image: "vision",
  capture_app_window: "vision",
  computer_system: "computer-use",
  computer_mouse: "computer-use",
  computer_keyboard: "computer-use",
  computer_ui: "computer-use",
  computer_screen: "computer-use",
  computer_handoff: "computer-use",
  computer_batch: "computer-use",
  convert_to_pdf: "filesystem",
  display_pdf: "filesystem",
  create_mcp_server: "mcp",
  update_mcp_server: "mcp",
  delete_mcp_server: "mcp",
  create_skill: "skills",
  update_skill: "skills",
  delete_skill: "skills",
  read_skill: "skills",
  search_skills: "skills",
  write_skill_file: "skills",
  patch_skill: "skills",
  merge_skills: "skills",
  deprecate_skill: "skills",
  install_skill: "skills",
  search_knowledge: "knowledge",
  read_knowledge: "knowledge",
  write_knowledge: "knowledge",
  patch_knowledge: "knowledge",
  delete_knowledge: "knowledge",
  read_user_memory: "memory",
  update_user_memory: "memory",
  read_project_memory: "memory",
  update_project_memory: "memory",
  search_session_history: "memory",
};

export type ToolCatalogEntry = {
  name: string;
  displayName: string;
  description: string;
  displayDescription: string;
  categoryId: ToolCategoryId;
  defaultPermissionLevel: PermissionLevel;
  permissionLevel: PermissionLevel;
  offered: boolean;
  offerLocked?: boolean;
  visible: boolean;
  displayLocked?: boolean;
  callCount?: number;
};

export function getToolCategory(id: ToolCategoryId): ToolCategory {
  const found = TOOL_CATEGORIES.find((c) => c.id === id);
  if (found) return found;
  return {
    id,
    label: id,
    description: "",
  };
}

export function groupToolsByCategory(
  entries: ToolCatalogEntry[],
): Array<{ category: ToolCategory; tools: ToolCatalogEntry[] }> {
  const byId = new Map<ToolCategoryId, ToolCatalogEntry[]>();
  for (const entry of entries) {
    const list = byId.get(entry.categoryId) ?? [];
    list.push(entry);
    byId.set(entry.categoryId, list);
  }

  const groups: Array<{ category: ToolCategory; tools: ToolCatalogEntry[] }> =
    [];
  for (const category of TOOL_CATEGORIES) {
    const tools = byId.get(category.id);
    if (!tools || tools.length === 0) continue;
    groups.push({ category, tools });
  }

  for (const [id, tools] of byId) {
    if (TOOL_CATEGORIES.some((c) => c.id === id)) continue;
    groups.push({ category: getToolCategory(id), tools });
  }
  return groups;
}

