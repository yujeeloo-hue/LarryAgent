import { isShellToolName } from "./shellToolName.js";

const INTERRUPTIBLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "read_image",
  "grep",
  "glob",
  "list_dir",
  "batch_search",
  "search_tools",
  "search_skills",
  "search_knowledge",
  "read_knowledge",
  "search_session_history",
]);

export function isInterruptibleToolName(name: string): boolean {
  return isShellToolName(name) || INTERRUPTIBLE_TOOL_NAMES.has(name);
}
