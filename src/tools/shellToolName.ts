import { IS_WINDOWS } from "../platformCaps.js";


export const SHELL_TOOL_NAME = IS_WINDOWS ? "exec_command" : "run_shell";

export const SHELL_TOOL_NAMES: readonly string[] = ["run_shell", "exec_command"];

export function isShellToolName(name: string): boolean {
  return name === "run_shell" || name === "exec_command";
}
