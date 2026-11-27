import type { CocoSnapshot, CocoWork, CocoWorkStatus } from "./types.js";

export const TERMINAL_WORK_STATUSES: readonly CocoWorkStatus[] = ["completed", "cancelled"];
export const ACTIVE_WORK_STATUSES: readonly CocoWorkStatus[] = ["executing", "recovering", "verifying"];
export const WORKSPACE_BUSY_STATUSES: readonly CocoWorkStatus[] = ["executing", "recovering", "verifying", "waiting", "to_decide"];

export const isTerminalWork = (status: CocoWorkStatus): boolean => TERMINAL_WORK_STATUSES.includes(status);
export const isActiveWork = (status: CocoWorkStatus): boolean => ACTIVE_WORK_STATUSES.includes(status);
export const occupiesWorkspace = (status: CocoWorkStatus): boolean => WORKSPACE_BUSY_STATUSES.includes(status);

export const isCocoUnavailable = (state: CocoSnapshot["state"] | undefined): boolean => state === "blocked" || state === "stopping";

export function stoppedByUser(lifecycle: { state: string; requestedStop?: string | undefined } | undefined): boolean {
  if (!lifecycle) return false;
  return [lifecycle.state, lifecycle.requestedStop].some(state => state === "user_stopped" || state === "user_paused");
}

export function abnormalInterruption(lifecycle: { state: string } | undefined, turnActive = false): boolean {
  if (!lifecycle || turnActive) return false;
  return ["interrupted", "failed", "shutdown", "coco_stopped", "running"].includes(lifecycle.state);
}

export function pausedForBudget(lifecycle: { state: string; requestedStop?: string | undefined } | undefined): boolean {
  if (!lifecycle) return false;
  return [lifecycle.state, lifecycle.requestedStop].some(state => state === "coco_budget");
}

export function workRank(work: Pick<CocoWork, "prioritySource" | "priority" | "deadlineAt">, waitingSince: number, now: number): number {
  const urgent = work.deadlineAt ? Math.max(0, 50 - (work.deadlineAt - now) / 3600000) : 0;
  return (work.prioritySource === "user" ? 1000 : 0) + work.priority + urgent + Math.min(30, (now - waitingSince) / 3600000);
}
