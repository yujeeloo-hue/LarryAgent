import { IS_WINDOWS } from "../platformCaps.js";

/**
 * Shell-tool naming (Windows v1: docs/plans/20260907-jellybot-windows-v1.md).
 *
 * The tool is registered as `exec_command` on Windows (cmd.exe semantics,
 * platform-aware description) and stays `run_shell` on macOS — byte-identical
 * to before. Every name-keyed site must go through this module instead of a
 * literal string, so both platforms (and historical DB rows) resolve.
 */

/** Canonical name for THIS build's registered shell tool. */
export const SHELL_TOOL_NAME = IS_WINDOWS ? "exec_command" : "run_shell";

/** Every name the shell tool has ever carried (DB rows, cross-platform data). */
export const SHELL_TOOL_NAMES: readonly string[] = ["run_shell", "exec_command"];

/** True when `name` refers to the shell tool under any historical name. */
export function isShellToolName(name: string): boolean {
  return name === "run_shell" || name === "exec_command";
}
