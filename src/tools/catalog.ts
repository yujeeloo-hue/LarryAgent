import type { BuiltinToolName, PermissionLevel } from "./types.js";

/** Tool grouping for Settings / Tools management UI. */
export type ToolCategoryId =
  | "filesystem"
  | "search"
  | "shell"
  | "interaction"
  | "orchestration"
  | "vision"
  | "mcp"
  | "skills"
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
    description: "Read and change files and directories in the workspace.",
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
    id: "vision",
    label: "Vision",
    description: "Understand local images with a vision-capable model.",
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
    id: "memory",
    label: "Memory",
    description:
      "User profile, project memory, and workspace conversation history.",
  },
];

export const TOOL_CATEGORY_BY_NAME: Record<BuiltinToolName, ToolCategoryId> = {
  read_file: "filesystem",
  write_file: "filesystem",
  dev_tasks: "filesystem",
  patch: "filesystem",
  list_dir: "filesystem",
  get_workspace_path: "filesystem",
  get_current_time: "interaction",
  grep: "search",
  symbols: "search",
  batch_search: "search",
  find_cxx_references: "search",
  run_shell: "shell",
  exec_command: "shell",
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
  fsm_graph: "orchestration",
  fsm_graph_edit: "orchestration",
  turn_handoff: "orchestration",
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
  install_skill: "skills",
  read_user_memory: "memory",
  update_user_memory: "memory",
  read_project_memory: "memory",
  update_project_memory: "memory",
  search_session_history: "memory",
};

export type ToolCatalogEntry = {
  name: string;
  displayName: string;
  /** Full model instructions; UI components must use displayDescription. */
  description: string;
  /** Concise human-facing summary for management interfaces. */
  displayDescription: string;
  categoryId: ToolCategoryId;
  defaultPermissionLevel: PermissionLevel;
  /** Effective level after runtime overrides. */
  permissionLevel: PermissionLevel;
  /** Whether this tool is in the always-offer set for the model. */
  offered: boolean;
  /** Forced meta tools cannot be deferred. */
  offerLocked?: boolean;
  /**
   * Whether this tool's card renders in the conversation flow.
   * false = execute + store as usual, render nothing.
   */
  visible: boolean;
  /** Interactive / plan-progress tools whose cards must always render. */
  displayLocked?: boolean;
  /** Lifetime invocation count from tool stats (when available). */
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

  // Any unknown category ids (future tools) appear last.
  for (const [id, tools] of byId) {
    if (TOOL_CATEGORIES.some((c) => c.id === id)) continue;
    groups.push({ category: getToolCategory(id), tools });
  }
  return groups;
}

