import type { CocoSnapshot, CocoWork, CocoWorkStatus } from "./types.js";

export const TERMINAL_WORK_STATUSES: readonly CocoWorkStatus[] = ["completed", "cancelled"];
/** Work with a live execution, recovery or verification stage. */
export const ACTIVE_WORK_STATUSES: readonly CocoWorkStatus[] = ["executing", "recovering", "verifying"];
/**
 * A project stays busy while one of its tasks may still read or write files.
 * Queued and draft tasks do not hold the project; another project can run beside these.
 */
export const WORKSPACE_BUSY_STATUSES: readonly CocoWorkStatus[] = ["executing", "recovering", "verifying", "waiting", "to_decide"];

export const isTerminalWork = (status: CocoWorkStatus): boolean => TERMINAL_WORK_STATUSES.includes(status);
export const isActiveWork = (status: CocoWorkStatus): boolean => ACTIVE_WORK_STATUSES.includes(status);
export const occupiesWorkspace = (status: CocoWorkStatus): boolean => WORKSPACE_BUSY_STATUSES.includes(status);

/** Runtime states in which CoCo cannot accept commands. */
export const isCocoUnavailable = (state: CocoSnapshot["state"] | undefined): boolean => state === "blocked" || state === "stopping";

/** The user explicitly stopped or paused the native turn; CoCo must wait for an explicit resume. */
export function stoppedByUser(lifecycle: { state: string; requestedStop?: string | undefined } | undefined): boolean {
  if (!lifecycle) return false;
  return [lifecycle.state, lifecycle.requestedStop].some(state => state === "user_stopped" || state === "user_paused");
}

/**
 * The turn journal already shows an abnormal cut: connection loss, failure,
 * shutdown, or a CoCo stop. A still-open `running` record counts only after
 * the caller has confirmed the turn is no longer active.
 */
export function abnormalInterruption(lifecycle: { state: string } | undefined, turnActive = false): boolean {
  if (!lifecycle || turnActive) return false;
  return ["interrupted", "failed", "shutdown", "coco_stopped", "running"].includes(lifecycle.state);
}

/** CoCo paused the native turn because the automation token budget was exhausted — auto-resumes after cooldown. */
export function pausedForBudget(lifecycle: { state: string; requestedStop?: string | undefined } | undefined): boolean {
  if (!lifecycle) return false;
  return [lifecycle.state, lifecycle.requestedStop].some(state => state === "coco_budget");
}

/** Scheduling rank shared by job admission and preemption checks. */
export function workRank(work: Pick<CocoWork, "prioritySource" | "priority" | "deadlineAt">, waitingSince: number, now: number): number {
  const urgent = work.deadlineAt ? Math.max(0, 50 - (work.deadlineAt - now) / 3600000) : 0;
  return (work.prioritySource === "user" ? 1000 : 0) + work.priority + urgent + Math.min(30, (now - waitingSince) / 3600000);
}
