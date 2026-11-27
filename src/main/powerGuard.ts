import { powerSaveBlocker } from "electron";
import { agentLogError, agentLogInfo, agentLogWarn } from "../logging/agentLog.js";


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

export function acquirePowerGuard(owner: string): void {
  refCount += 1;
  if (refCount === 1) startBlocker(owner);
}

export function releasePowerGuard(owner: string): void {
  if (refCount === 0) {
    agentLogWarn("powerguard.underflow", { owner });
    return;
  }
  refCount -= 1;
  if (refCount === 0) stopBlocker(owner);
}
