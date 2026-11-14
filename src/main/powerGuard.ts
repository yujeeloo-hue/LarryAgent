import { powerSaveBlocker } from "electron";
import { agentLogError, agentLogInfo, agentLogWarn } from "../logging/agentLog.js";

/**
 * Reference-counted "keep the Mac awake while agent work is running" guard.
 * `prevent-display-sleep` keeps display AND system awake while work runs —
 * the screen stays on (no display sleep, no lock) so long runs remain
 * visibly alive. (Until 2026-11-11 this used `prevent-app-suspension`,
 * which let the display sleep on its idle timer: tasks kept running in the
 * dark, but the dark + locked screen read as an interruption.)
 *
 * Holders all share one counter, so concurrent sessions and runs keep a
 * single powerSaveBlocker alive:
 * - per turn: sessionRuntime acquires on turn start, releases in the turn
 *   `finally`;
 * - per supervised run: CoCo execution (cocoExecution) and CoCo chat
 *   (cocoConversation) hold the guard for the whole run — including
 *   between-turn polls and retries — so macOS cannot idle-sleep in a
 *   turn-boundary gap while the session is still running.
 */

let refCount = 0;
let blockerId: number | null = null;

function startBlocker(owner: string): void {
  if (blockerId !== null) return;
  try {
    blockerId = powerSaveBlocker.start("prevent-display-sleep");
    agentLogInfo("powerguard.started", { owner, blockerId });
  } catch (err) {
    blockerId = null;
    agentLogError("powerguard.start_failed", {
      owner,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function stopBlocker(owner: string): void {
  const id = blockerId;
  blockerId = null;
  if (id === null) return;
  try {
    if (powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id);
    }
    agentLogInfo("powerguard.stopped", { owner, blockerId: id });
  } catch (err) {
    agentLogError("powerguard.stop_failed", {
      owner,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Call when an agent turn starts. Idempotent per acquire/release pair. */
export function acquirePowerGuard(owner: string): void {
  refCount += 1;
  if (refCount === 1) startBlocker(owner);
}

/** Call when that turn ends. The blocker stops when the last turn finishes. */
export function releasePowerGuard(owner: string): void {
  if (refCount === 0) {
    agentLogWarn("powerguard.underflow", { owner });
    return;
  }
  refCount -= 1;
  if (refCount === 0) stopBlocker(owner);
}
