import { isShellToolName } from "./shellToolName.js";

/**
 * Interrupt-mode tool classification
 *
 * When a queued prompt is armed as `interrupt`, firing the turn's interrupt
 * signal aborts the in-flight model stream AND the running calls of
 * interruptible-class tools (long-running, side-effect-free reads and the
 * shell). An already-running write-class call — patch / write_file /
 * subagents / skill & memory mutations — finishes first. Unstarted calls
 * in the superseded batch are cancelled before the new prompt inserts.
 *
 * New tools default to write-class (safe but slower to interrupt): add a
 * name here only when aborting mid-call is provably side-effect-free.
 */
const INTERRUPTIBLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "read_image",
  "grep",
  "glob",
  "list_dir",
  "batch_search",
  "search_tools",
  "search_skills",
  "search_session_history",
]);

/** True when a running call of this tool may be aborted by an interrupt. */
export function isInterruptibleToolName(name: string): boolean {
  return isShellToolName(name) || INTERRUPTIBLE_TOOL_NAMES.has(name);
}
