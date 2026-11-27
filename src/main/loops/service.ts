import type { DatabaseSync } from "node:sqlite";
import { app } from "electron";
import {
  deleteLoop,
  getDaemonInfo,
  getDaemonStoppedByUser,
  getLoop,
  insertLoop,
  listLoopRuns,
  listLoops,
  openLoopsDb,
  setDaemonStoppedByUser,
  setLoopEnabled,
  updateLoop,
  type LoopPatch,
  type LoopRecord,
  type LoopRunMode,
  type LoopRunRecord,
} from "../../loops/db.js";
import {
  describeCadence,
  isValidCadence,
  nextRunAt,
  type Cadence,
} from "../../loops/schedule.js";
import { loopsDaemonManaged } from "../../platformCaps.js";
import {
  getLoopsDaemonStatus,
  installLoopsDaemon,
  stopLoopsDaemon,
  uninstallLoopsDaemon,
  ensureLoopsDaemonInstalled,
  repairLoopsDaemonIfStale,
} from "./daemonControl.js";
import type { InAppScheduler } from "./inAppScheduler.js";
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../../llm/reasoningEffort.js";

export type LoopView = LoopRecord & { cadenceSummary: string };

export type LoopsDaemonView = {
  loaded: boolean;
  state: string | null;
  pid: number | null;
  plistExists: boolean;
  plistStale: boolean;
  lastError: string | null;
  heartbeatAt: number | null;
  heartbeatPid: number | null;
  daemonVersion: string | null;
  heartbeatStale: boolean;
  stoppedByUser: boolean;
  appVersion: string;
  inApp: boolean;
};

const HEARTBEAT_STALE_MS = 90_000;

export type LoopInput = {
  name: string;
  prompt: string;
  workspaceId: string;
  runMode: LoopRunMode;
  providerId: string;
  reasoningEffort: ReasoningEffort;
  fullPermissions: boolean;
  cadence: Cadence;
  enabled: boolean;
};

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`loops: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseRunMode(value: unknown): LoopRunMode {
  if (value === "agent" || value === "plan" || value === "ask") return value;
  throw new Error("loops: runMode must be one of agent|plan|ask");
}

function parseCadence(value: unknown): Cadence {
  if (!isValidCadence(value)) {
    throw new Error("loops: cadence is invalid");
  }
  return value;
}

function computeNextRun(cadence: Cadence, enabled: boolean): number | null {
  return enabled ? nextRunAt(cadence, new Date()).getTime() : null;
}

function toView(loop: LoopRecord): LoopView {
  return { ...loop, cadenceSummary: describeCadence(parseCadenceJson(loop.cadenceJson)) };
}

function parseCadenceJson(json: string): Cadence {
  const parsed = JSON.parse(json) as unknown;
  if (!isValidCadence(parsed)) {
    throw new Error("loops: stored cadence is invalid");
  }
  return parsed;
}

function normalizeInput(raw: unknown): LoopInput {
  if (raw === null || typeof raw !== "object") {
    throw new Error("loops: loop payload must be an object");
  }
  const req = raw as Record<string, unknown>;
  return {
    name: requireNonEmptyString(req.name, "name"),
    prompt: requireNonEmptyString(req.prompt, "prompt"),
    workspaceId: requireNonEmptyString(req.workspaceId, "workspaceId"),
    runMode: parseRunMode(req.runMode),
    providerId:
      typeof req.providerId === "string" ? req.providerId : "",
    reasoningEffort: normalizeReasoningEffort(
      req.reasoningEffort ?? req.reasoningMax,
    ),
    fullPermissions: req.fullPermissions === true,
    cadence: parseCadence(req.cadence),
    enabled: req.enabled !== false,
  };
}

export function createLoopsService(
  appDataRoot: string,
  options: {
    scheduler?: InAppScheduler;
  } = {},
): {
  db: DatabaseSync;
  list: () => LoopView[];
  create: (raw: unknown) => LoopView;
  update: (id: string, raw: unknown) => LoopView | null;
  remove: (id: string) => boolean;
  setEnabled: (id: string, enabled: boolean) => LoopView | null;
  listRuns: (id: string, limit?: number) => LoopRunRecord[];
  daemonStatus: () => Promise<LoopsDaemonView>;
  installDaemon: () => Promise<LoopsDaemonView>;
  stopDaemon: () => Promise<LoopsDaemonView>;
  uninstallDaemon: () => Promise<{ ok: boolean; message?: string }>;
  ensureDaemon: () => Promise<LoopsDaemonView>;
  repairDaemon: () => Promise<LoopsDaemonView>;
} {
  const db = openLoopsDb(appDataRoot);
  if (!loopsDaemonManaged && !options.scheduler) {
    throw new Error("loops: in-app scheduler is required on this platform");
  }
  const scheduler = options.scheduler;

  const inAppView = (): LoopsDaemonView => {
    const status = scheduler!.status();
    const info = getDaemonInfo(db);
    const heartbeatAt = info?.heartbeatAt ?? status.heartbeatAt;
    return {
      loaded: status.running,
      state: status.running ? "running" : null,
      pid: status.running ? process.pid : null,
      plistExists: true,
      plistStale: false,
      lastError: null,
      heartbeatAt,
      heartbeatPid: info?.pid ?? process.pid,
      daemonVersion: info?.appVersion ?? null,
      heartbeatStale:
        status.running &&
        (heartbeatAt === null || Date.now() - heartbeatAt > HEARTBEAT_STALE_MS),
      stoppedByUser: status.stoppedByUser,
      appVersion: app.getVersion(),
      inApp: true,
    };
  };

  const withDaemonInfo = async (): Promise<LoopsDaemonView> => {
    if (!loopsDaemonManaged) return inAppView();
    const status = await getLoopsDaemonStatus();
    const info = getDaemonInfo(db);
    const running = status.state === "running";
    return {
      ...status,
      heartbeatAt: info?.heartbeatAt ?? null,
      heartbeatPid: info?.pid ?? null,
      daemonVersion: info?.appVersion ?? null,
      heartbeatStale:
        running &&
        (info === null || Date.now() - info.heartbeatAt > HEARTBEAT_STALE_MS),
      stoppedByUser: getDaemonStoppedByUser(db),
      appVersion: app.getVersion(),
      inApp: false,
    };
  };

  return {
    db,
    list: () => listLoops(db).map(toView),
    create: (raw) => {
      const input = normalizeInput(raw);
      const view = toView(
        insertLoop(db, {
          ...input,
          cadenceJson: JSON.stringify(input.cadence),
          nextRunAt: computeNextRun(input.cadence, input.enabled),
        }),
      );
      scheduler?.kick();
      return view;
    },
    update: (id, raw) => {
      const input = normalizeInput(raw);
      const patch: LoopPatch = {
        ...input,
        cadenceJson: JSON.stringify(input.cadence),
        nextRunAt: computeNextRun(input.cadence, input.enabled),
      };
      const updated = updateLoop(db, id, patch);
      scheduler?.kick();
      return updated ? toView(updated) : null;
    },
    remove: (id) => {
      const ok = deleteLoop(db, id);
      if (ok) scheduler?.kick();
      return ok;
    },
    setEnabled: (id, enabled) => {
      const loop = getLoop(db, id);
      if (!loop) return null;
      const next = enabled
        ? computeNextRun(parseCadenceJson(loop.cadenceJson), true)
        : null;
      if (loop.enabled !== enabled || loop.nextRunAt !== next) {
        setLoopEnabled(db, id, enabled);
        updateLoop(db, id, { nextRunAt: next });
      }
      const refreshed = getLoop(db, id);
      if (refreshed) scheduler?.kick();
      return refreshed ? toView(refreshed) : null;
    },
    listRuns: (id, limit = 20) => listLoopRuns(db, id, limit),
    daemonStatus: withDaemonInfo,
    installDaemon: async () => {
      setDaemonStoppedByUser(db, false);
      if (!loopsDaemonManaged) {
        scheduler!.start();
      } else {
        await installLoopsDaemon();
      }
      return withDaemonInfo();
    },
    stopDaemon: async () => {
      setDaemonStoppedByUser(db, true);
      if (!loopsDaemonManaged) {
        scheduler!.stop(false);
      } else {
        await stopLoopsDaemon();
      }
      return withDaemonInfo();
    },
    uninstallDaemon: async () => {
      if (!loopsDaemonManaged) {
        scheduler!.stop(true);
        return { ok: true };
      }
      const result = await uninstallLoopsDaemon();
      setDaemonStoppedByUser(db, false);
      return result;
    },
    ensureDaemon: async () => {
      if (getDaemonStoppedByUser(db)) return withDaemonInfo();
      if (!loopsDaemonManaged) {
        scheduler!.start();
        return withDaemonInfo();
      }
      await ensureLoopsDaemonInstalled();
      return withDaemonInfo();
    },
    repairDaemon: async () => {
      if (getDaemonStoppedByUser(db)) return withDaemonInfo();
      if (!loopsDaemonManaged) {
        scheduler!.start();
        return withDaemonInfo();
      }
      await repairLoopsDaemonIfStale();
      return withDaemonInfo();
    },
  };
}

export type LoopsService = ReturnType<typeof createLoopsService>;
