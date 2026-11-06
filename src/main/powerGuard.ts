import { powerSaveBlocker } from "electron";
import { agentLogError, agentLogInfo } from "../logging/agentLog.js";

/**
 * Reference-counted "keep the Mac awake while an agent turn is running"
 * guard. The display may still sleep (`prevent-app-suspension`); we only
 * block idle system sleep so long tool runs are not suspended mid-flight.
 *
 * acquire on turn start, release on turn end (finally). Multiple concurrent
 * sessions share one powerSaveBlocker id.
 */

let refCount = 0;
let blockerId: number | null = null;

function startBlocker(owner: string): void {
  if (blockerId !== null) return;
  try {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
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
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) stopBlocker(owner);
}
