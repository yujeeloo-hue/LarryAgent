/**
 * Renderer-side shell-tool naming (Windows v1).
 *
 * Mirrors src/tools/shellToolName.ts, which renderer code cannot import: it
 * reads process.platform, and the sandboxed renderer has no `process`. Here
 * the platform comes from the preload bridge instead. Keep both files in
 * sync (run_shell / exec_command).
 */

// Node (unit tests) has no window — default to the macOS-equivalent name.
const platform: string =
  typeof window !== "undefined"
    ? (window.jellybot?.platform ?? "")
    : "";

/** Canonical shell-tool name for THIS platform's build. */
export const SHELL_TOOL_NAME = platform === "win32" ? "exec_command" : "run_shell";

/** True when `name` refers to the shell tool under any historical name. */
export function isShellToolName(name: string): boolean {
  return name === "run_shell" || name === "exec_command";
}
