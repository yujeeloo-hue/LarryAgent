export type DebugTargetStatus = "starting" | "running" | "stopped" | "ended";

export function shouldStealDebugFocus(
  focusedStatus: DebugTargetStatus | undefined,
): boolean {
  return focusedStatus === undefined || focusedStatus === "running" || focusedStatus === "starting";
}
