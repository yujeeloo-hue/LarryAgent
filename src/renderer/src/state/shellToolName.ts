
const platform: string =
  typeof window !== "undefined"
    ? (window.jellybot?.platform ?? "")
    : "";

export const SHELL_TOOL_NAME = platform === "win32" ? "exec_command" : "run_shell";

export function isShellToolName(name: string): boolean {
  return name === "run_shell" || name === "exec_command";
}
