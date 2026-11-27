import type { DatabaseSync } from "node:sqlite";
import { reclaimStaleRuns, runSchedulerPass } from "../../loops/daemonCore.js";
import { createSessionExecutor } from "../../loops/sessionExecutor.js";
import {
  getDaemonStoppedByUser,
  nextEnabledRunAt,
  setDaemonStoppedByUser,
  updateDaemonHeartbeat,
} from "../../loops/db.js";
import type { SessionExecutorOptions, SessionExecutorStore } from "../../loops/sessionExecutor.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

export const IN_APP_SCHEDULER_VERSION = "0.1.0";

export type InAppSchedulerStatus = {
  running: boolean;
  startedAt: number | null;
  heartbeatAt: number | null;
  stoppedByUser: boolean;
};

export type InAppScheduler = {
  start(): void;
  stop(markStoppedByUser: boolean): void;
  isRunning(): boolean;
  status(): InAppSchedulerStatus;
  kick(): void;
};

export type InAppSchedulerOptions = {
  log?: (message: string) => void;
  onError?: (message: string, error: unknown) => void;
  heartbeatIntervalMs?: number;
  executorOptions?: SessionExecutorOptions;
  now?: () => number;
};

export function createInAppScheduler(
  db: DatabaseSync,
  store: SessionExecutorStore,
  options: InAppSchedulerOptions = {},
): InAppScheduler {
  const log = options.log ?? (() => {});
  const onError = options.onError ?? (() => {});
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? Date.now;

  const executor = createSessionExecutor(store, options.executorOptions);
  let running = false;
  let startedAt: number | null = null;
  let heartbeatAt: number | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let stuckDueAt: number | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  const heartbeat = (): void => {
    try {
      updateDaemonHeartbeat(db, process.pid, IN_APP_SCHEDULER_VERSION);
      heartbeatAt = now();
    } catch (error) {
      onError("heartbeat failed", error);
    }
  };

  const scan = async (): Promise<void> => {
    if (!running) return;
    try {
      const result = await runSchedulerPass(db, executor);
      const total = result.ran + result.skipped + result.failed;
      if (total > 0) {
        log(
          `pass: ${total} due loop(s) — ok=${result.ran} skipped=${result.skipped} failed=${result.failed}`,
        );
      }
    } catch (error) {
      onError("scheduler pass failed", error);
    }
  };

  const clearScanTimer = (): void => {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
  };

  const scheduleScan = (): void => {
    if (!running) {
      clearScanTimer();
      stuckDueAt = null;
      return;
    }
    const next = nextEnabledRunAt(db);
    if (next == null) {
      clearScanTimer();
      stuckDueAt = null;
      return;
    }
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now()));
    if (delay === 0 && stuckDueAt === next) return;
    clearScanTimer();
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (!running || inFlight) return;
      inFlight = scan().finally(() => {
        inFlight = null;
        const after = nextEnabledRunAt(db);
        stuckDueAt = delay === 0 && after === next ? next : null;
        scheduleScan();
      });
    }, delay);
    scanTimer.unref?.();
  };

  const runScan = (): void => {
    if (!running || inFlight) return;
    inFlight = scan().finally(() => {
      inFlight = null;
      scheduleScan();
    });
  };

  return {
    start(): void {
      if (running) return;
      if (getDaemonStoppedByUser(db)) return;
      running = true;
      startedAt = now();
      const reclaimed = reclaimStaleRuns(db, "scheduler restarted during run");
      if (reclaimed > 0) {
        log(`reclaimed ${reclaimed} stale run(s) left running by a previous scheduler`);
      }
      heartbeat();
      heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
      runScan();
      log(`in-app scheduler started pid=${process.pid} version=${IN_APP_SCHEDULER_VERSION}`);
    },
    stop(markStoppedByUser): void {
      if (!running) {
        if (markStoppedByUser) setDaemonStoppedByUser(db, true);
        return;
      }
      running = false;
      stuckDueAt = null;
      clearScanTimer();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (markStoppedByUser) setDaemonStoppedByUser(db, true);
      startedAt = null;
      log("in-app scheduler stopped");
    },
    isRunning(): boolean {
      return running;
    },
    status(): InAppSchedulerStatus {
      return {
        running,
        startedAt,
        heartbeatAt,
        stoppedByUser: getDaemonStoppedByUser(db),
      };
    },
    kick(): void {
      runScan();
    },
  };
}
