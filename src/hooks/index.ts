export type {
  HookBasePayload,
  HookCommandConfig,
  HookDecision,
  HookEventName,
  HookListEntry,
  HookPayload,
  HookPermission,
  HookRunner,
  HookRunnerOptions,
  HooksFileConfig,
  InProcessHookHandler,
  InProcessHookRegistration,
  MergedHookResult,
} from "./types.js";

export {
  userHooksPath,
  projectHooksPath,
  
} from "./config.js";

export { createHookRunner, createTurnHookRunner } from "./runner.js";
export { createHooksService } from "./service.js";
export type { HooksSnapshot } from "./service.js";

/** Helpers for tool-name classification used by runTools. */
export function isShellToolName(name: string): boolean {
  // Keep in sync with src/tools/shellToolName.ts (run_shell / exec_command).
  return name === "run_shell" || name === "exec_command";
}

export function isReadFileToolName(name: string): boolean {
  return (
    name === "read_file" ||
    name === "read_image" ||
    name === "display_image" ||
    name === "display_pdf"
  );
}

export function isFileEditToolName(name: string): boolean {
  return (
    name === "write_file" ||
    name === "patch" ||
    name === "append_file" ||
    name === "edit_file" ||
    name === "convert_to_pdf" ||
    name === "capture_app_window" ||
    name === "generate_image"
  );
}
