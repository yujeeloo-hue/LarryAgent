/**
 * Windows in-app Loops scheduler — Phase 1 of Windows Loops
 * (docs/plans/20260907-jellybot-windows-v1.md follow-up).
 *
 * macOS delegates scheduling to a launchd-managed daemon process; Windows
 * has no per-user service manager we are willing to ship in v1, so the
 * resident-tray app process *is* the scheduler: every SCAN_INTERVAL the
 * main process runs the same pure scheduler pass (runSchedulerPass) the
 * daemon uses, against the same loops.sqlite. Turns execute through the
 * app's own session store, so loop runs stream in the sidebar natively —
 * the macOS app-handoff experience without the unix socket.
 *
 * Lifecycle:
 * - start(): boots lazily, or immediately when loops already exist.
 * - Main-process timers only — the hidden-window renderer rAF freeze and
 *   the 1 Hz setTimeout clamp never apply here.
 * - stop(): user pressed Stop on the Loops screen (persisted marker); a
 *   later start() revives it (the same marker cleared path as macOS).
 * - before-quit: clear timers; in-flight passes are awaited with a grace
 *   budget by the app's quit sequence (persistRunningSessionsOnQuit
 *   flushes mid-turn transcripts).
 *
 * Sleep/resume: the timer simply keeps firing; catch-up semantics collapse
 * missed occurrences into one run (identical to the daemon).
 */
import type { DatabaseSync } from "node:sqlite";
import { reclaimStaleRuns, runSchedulerPass } from "../../loops/daemonCore.js";
import { createSessionExecutor } from "../../loops/sessionExecutor.js";
import {
  getDaemonStoppedByUser,
  setDaemonStoppedByUser,
  updateDaemonHeartbeat,
} from "../../loops/db.js";
import type { SessionExecutorOptions, SessionExecutorStore } from "../../loops/sessionExecutor.js";

/** Mirrors daemonMain: scan every 20s, heartbeat every 30s. */
const SCAN_INTERVAL_MS = 20_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Version tag for the in-app scheduler (daemon_info row). */
export const IN_APP_SCHEDULER_VERSION = "0.1.0";

export type InAppSchedulerStatus = {
  running: boolean;
  startedAt: number | null;
  /** Heartbeat row from loops.db (null before the first beat). */
  heartbeatAt: number | null;
  stoppedByUser: boolean;
};

export type InAppScheduler = {
  start(): void;
  stop(markStoppedByUser: boolean): void;
  isRunning(): boolean;
  status(): InAppSchedulerStatus;
  /** Rescan immediately (e.g. after a loop was created/edited). */
  kick(): void;
};

export type InAppSchedulerOptions = {
  log?: (message: string) => void;
  onError?: (message: string, error: unknown) => void;
  scanIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** Polling knobs for the shared session executor (tests shorten these). */
  executorOptions?: SessionExecutorOptions;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
};

/**
 * Create the in-app scheduler. Pure dependency injection (db + session
 * store contract) — no Electron imports, so node:test can drive it with
 * a temp loops.sqlite and a fake store.
 */
export function createInAppScheduler(
  db: DatabaseSync,
  store: SessionExecutorStore,
  options: InAppSchedulerOptions = {},
): InAppScheduler {
  const log = options.log ?? (() => {});
  const onError = options.onError ?? (() => {});
  const scanIntervalMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? Date.now;

  const executor = createSessionExecutor(store, options.executorOptions);
  let running = false;
  let startedAt: number | null = null;
  let heartbeatAt: number | null = null;
  let scanTimer: ReturnType<typeof setInterval> | null = null;
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
      // Single-pass failures must never take the scheduler down (daemon parity).
      onError("scheduler pass failed", error);
    }
  };

  const arm = (): void => {
    if (scanTimer || !running) return;
    // Boot catch-up pass first, then the interval (daemon parity).
    inFlight = scan().finally(() => {
      inFlight = null;
    });
    scanTimer = setInterval(() => {
      inFlight = scan().finally(() => {
        inFlight = null;
      });
    }, scanIntervalMs);
    heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
  };

  return {
    start(): void {
      if (running) return;
      // Respect the persisted deliberate-stop marker: the Loops screen's
      // explicit Start button clears it (see service.ts installDaemon).
      if (getDaemonStoppedByUser(db)) return;
      running = true;
      startedAt = now();
      const reclaimed = reclaimStaleRuns(db, "scheduler restarted during run");
      if (reclaimed > 0) {
        log(`reclaimed ${reclaimed} stale run(s) left running by a previous scheduler`);
      }
      heartbeat();
      arm();
      log(`in-app scheduler started pid=${process.pid} version=${IN_APP_SCHEDULER_VERSION}`);
    },
    stop(markStoppedByUser): void {
      if (!running) {
        // Stopping while never started still records the user's intent so
        // auto paths (app boot) do not resurrect it.
        if (markStoppedByUser) setDaemonStoppedByUser(db, true);
        return;
      }
      running = false;
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }
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
      if (!running) return;
      if (inFlight) return; // the next interval tick picks the change up
      inFlight = scan().finally(() => {
        inFlight = null;
      });
    },
  };
}
