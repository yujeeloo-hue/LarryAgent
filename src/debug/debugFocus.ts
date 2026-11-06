export type DebugTargetStatus = "starting" | "running" | "stopped" | "ended";

/** Auto-switch the debug panel when a session pauses, unless the user is stepping elsewhere. */
export function shouldStealDebugFocus(
  focusedStatus: DebugTargetStatus | undefined,
): boolean {
  return focusedStatus === undefined || focusedStatus === "running" || focusedStatus === "starting";
}
