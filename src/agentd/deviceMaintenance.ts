/**
 * Device maintenance surface for the agentd runtime — the implementation
 * behind the remoteBridge maintenance actions (deviceStatus / restartDevice /
 * updateDevice / rebootDevice / checkUpdate).
 *
 * Privileged work is never done in this process. The service runs with
 * NoNewPrivileges, so sudo cannot succeed here. Both update and reboot drop
 * a request file; a root systemd path unit performs the action.
 *
 * Progress flows back through <dataDir>/update-status/current.json, which a
 * 2s poller watches and forwards as maintenance state pushes. A queued or
 * running phase whose timestamp stops moving, and whose oneshot is not
 * active, is rewritten to failed so the console can unlock.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, readdirSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { hostname, uptime as osUptime } from "node:os";
import { join } from "node:path";
import type {
  RemoteDeviceMaintenance,
  RemoteMaintenanceState,
} from "../remote/remoteBridge.js";
import { writeJsonAtomic } from "./atomicJson.js";
import {
  performAgentdUpdate,
  defaultInstallDir,
  type AgentdUpdateStepEvent,
} from "./update.js";
import {
  AGENTD_REBOOT_PATH_UNIT,
  AGENTD_REBOOT_SERVICE,
  AGENTD_UPDATER_PATH_UNIT,
  AGENTD_UPDATER_SERVICE,
  resolveAgentdUpdateQueueDir,
  resolveAgentdUpdateStatusDir,
} from "./config.js";

export interface DeviceMaintenanceDeps {
  dataDir: string;
  version: string;
  /** Wire the graceful shutdown path (runMain stop hook). */
  requestRestart: () => void;
  /** Live state sink → bridge.pushMaintenanceState. */
  onStateChange?: (state: RemoteMaintenanceState) => void;
  /** Injectable clock/spawner for tests. */
  now?: () => number;
  /** Injectable host uptime (seconds) — tests pin the boot moment. */
  uptimeFn?: () => number;
  fetchFn?: typeof fetch;
  /** Dev-only: skip the queue and run updates in-process (test/dev dirs). */
  allowInProcessUpdate?: boolean;
  pollIntervalMs?: number;
  /**
   * Production channel probes. Defaults are safe (channel absent) so unit
   * tests never spawn systemctl; runMain wires the real `systemctl is-active`
   * checks.
   */
  updaterReady?: () => boolean;
  rebootReady?: () => boolean;
  /** True while the root update oneshot is running. */
  updateBusy?: () => boolean;
  /** True while the root reboot oneshot is running. */
  rebootBusy?: () => boolean;
}

/** How long a queued/running phase may sit without a fresh timestamp. */
export const MAINTENANCE_PROGRESS_FRESH_MS = 45_000;

const REBOOT_HINT =
  "reboot channel is not active — install the root helper once with: sudo agentd install-updater";

const UPDATER_HINT =
  "updater is not active — run: sudo agentd install-updater (if it is already installed: systemctl reset-failed jellybot-agentd-update.path && systemctl restart jellybot-agentd-update.path)";

/** systemd sets both for services; a manual `agentd run` has neither. */
export function supervisedBySystemd(): boolean {
  return Boolean(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
}

/** `systemctl is-active` for a unit. activating/reloading count as up. */
export function systemdUnitActive(unit: string, spawnFn: typeof spawnSync = spawnSync): boolean {
  const result = spawnFn("systemctl", ["is-active", unit], {
    encoding: "utf8",
    timeout: 3000,
  });
  const state = String(result.stdout ?? "").trim();
  return state === "active" || state === "activating" || state === "reloading";
}

export function defaultMaintenanceProbes(): Pick<
  DeviceMaintenanceDeps,
  "updaterReady" | "rebootReady" | "updateBusy" | "rebootBusy"
> {
  return {
    updaterReady: () => systemdUnitActive(AGENTD_UPDATER_PATH_UNIT),
    rebootReady: () => systemdUnitActive(AGENTD_REBOOT_PATH_UNIT),
    updateBusy: () => systemdUnitActive(AGENTD_UPDATER_SERVICE),
    rebootBusy: () => systemdUnitActive(AGENTD_REBOOT_SERVICE),
  };
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function createDeviceMaintenance(deps: DeviceMaintenanceDeps): RemoteDeviceMaintenance & {
  stop(): void;
} {
  const now = deps.now ?? Date.now;
  const uptimeFn = deps.uptimeFn ?? osUptime;
  const fetchFn = deps.fetchFn ?? fetch;
  const queueDir = resolveAgentdUpdateQueueDir(deps.dataDir);
  const statusDir = resolveAgentdUpdateStatusDir(deps.dataDir);
  const statusFile = join(statusDir, "current.json");
  const requestPath = join(queueDir, "request.json");
  const rebootPath = join(queueDir, "reboot.json");
  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const updaterReady = deps.updaterReady ?? (() => false);
  const rebootReady = deps.rebootReady ?? (() => false);
  const updateBusy = deps.updateBusy ?? (() => false);
  const rebootBusy = deps.rebootBusy ?? (() => false);

  let currentState: RemoteMaintenanceState | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const setState = (state: RemoteMaintenanceState | null): void => {
    currentState = state;
    if (state) deps.onStateChange?.(state);
  };

  const readStateFile = (): RemoteMaintenanceState | null => {
    try {
      const parsed = JSON.parse(readFileSync(statusFile, "utf8")) as RemoteMaintenanceState;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.phase === "string" &&
        typeof parsed.ts === "number"
      ) {
        return parsed;
      }
    } catch {
      /* absent/unreadable → nothing to report */
    }
    return null;
  };

  const publish = (state: RemoteMaintenanceState): void => {
    currentState = state;
    deps.onStateChange?.(state);
  };

  /** Fresh queued/running work should reject a second conflicting action. */
  const progressFresh = (state: RemoteMaintenanceState | null): boolean => {
    if (!state || (state.phase !== "queued" && state.phase !== "running")) return false;
    return now() - state.ts < MAINTENANCE_PROGRESS_FRESH_MS;
  };

  const failStale = (state: RemoteMaintenanceState): RemoteMaintenanceState => {
    const error =
      state.source === "reboot"
        ? "reboot helper did not start — jellybot-agentd-reboot.path is not processing the queue"
        : state.phase === "queued"
          ? "updater did not start — jellybot-agentd-update.path is not processing the queue"
          : "update stopped reporting progress and the updater is not running";
    return { ...state, phase: "failed", error, ts: now() };
  };

  const syncFromDisk = (): void => {
    // While an in-process update owns the state (dev channel), the disk
    // file may legitimately not exist yet — never clobber the live run.
    if (inFlight) return;
    let next = readStateFile();
    // A reboot that really happened can never report success: the host
    // powers off mid-flight, so the worker's terminal write never lands.
    // Coming back up IS the success signal — a queued/running reboot record
    // stamped before this boot means the machine went down and returned.
    // Settle it as done here; without this the staleness watchdog brands
    // every successful remote reboot as "helper did not start" (Pi console
    // red card, 2026-10-13 — the reboot had actually worked).
    if (
      next &&
      next.source === "reboot" &&
      (next.phase === "queued" || next.phase === "running") &&
      next.ts < now() - uptimeFn() * 1000
    ) {
      const logTail = next.logTail
        ? `${next.logTail}\nhost rebooted — back online`
        : "host rebooted — back online";
      next = {
        phase: "done",
        ...(next.id ? { id: next.id } : {}),
        source: "reboot",
        logTail,
        ts: now(),
      };
      const settled = next;
      void writeJsonAtomic(statusFile, settled).catch(() => {});
    }
    if (
      next &&
      (next.phase === "queued" || next.phase === "running") &&
      now() - next.ts >= MAINTENANCE_PROGRESS_FRESH_MS
    ) {
      const busy = next.source === "reboot" ? rebootBusy() : updateBusy();
      if (!busy) {
        next = failStale(next);
        const frozen = next;
        void writeJsonAtomic(statusFile, frozen).catch(() => {});
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(currentState)) {
      currentState = next;
      if (next) deps.onStateChange?.(next);
    }
  };

  /** Queue writability probe — necessary, not sufficient (see updaterReady). */
  const queueAvailable = async (): Promise<boolean> => {
    try {
      await mkdir(queueDir, { recursive: true });
      await writeFile(join(queueDir, ".probe"), String(now()), "utf8");
      return true;
    } catch {
      return false;
    }
  };

  const installDir = defaultInstallDir();
  const symlinkTarget = (name: string): string | null => {
    try {
      return readlinkSync(join(installDir, name));
    } catch {
      return null;
    }
  };
  const listReleases = (): string[] => {
    try {
      return readdirSync(installDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };

  const maintenance: RemoteDeviceMaintenance & { stop(): void } = {
    // agentd's service runs inside a systemd sandbox (NoNewPrivileges +
    // ProtectSystem=strict), which is what makes the remote shell safe to
    // expose. Desktop clients deliberately never set this.
    execSupported: true,
    status() {
      return {
        agent: "agentd",
        version: deps.version,
        pid: process.pid,
        hostname: hostname(),
        uptimeSec: Math.floor(osUptime()),
        processUptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: `${process.platform} ${process.arch}`,
        supervised: supervisedBySystemd(),
        installDir,
        current: symlinkTarget("current"),
        previous: symlinkTarget("previous"),
        releases: listReleases(),
        maintenance: currentState,
      };
    },

    currentState() {
      return currentState;
    },

    restart() {
      if (!supervisedBySystemd()) {
        throw new Error(
          "restart needs systemd supervision — run the node via `systemctl start jellybot-agentd` (a manual `agentd run` would exit and stay down)",
        );
      }
      // The bridge has already put the ack on the wire by the time this
      // timer fires (sync ws send + 400ms flush window).
      setTimeout(() => deps.requestRestart(), 400);
      return { restarting: true, supervisor: "systemd" };
    },

    async reboot() {
      if (!rebootReady()) throw new Error(REBOOT_HINT);
      if (rebootBusy()) throw new Error("a reboot is already in progress");
      const live = currentState ?? readStateFile();
      if (live && live.source !== "reboot" && progressFresh(live)) {
        throw new Error("an update is in progress — wait for it to finish before rebooting");
      }
      if (live?.source === "reboot" && progressFresh(live)) {
        throw new Error("a reboot is already queued");
      }
      const id = `${now()}-${randomUUID().slice(0, 8)}`;
      await mkdir(queueDir, { recursive: true });
      // Remove a leftover so PathExistsGlob sees a new file.
      rmSync(rebootPath, { force: true });
      const tmp = join(queueDir, `.reboot-${id}.json`);
      await writeFile(tmp, `${JSON.stringify({ id }, null, 2)}\n`, "utf8");
      await rename(tmp, rebootPath);
      const state: RemoteMaintenanceState = { phase: "queued", id, source: "reboot", ts: now() };
      await writeJsonAtomic(statusFile, state);
      publish(state);
      return { rebooting: true };
    },

    async update(input) {
      if (inFlight) {
        throw new Error("an update is already in flight — wait for it to finish");
      }
      const source = input.source.trim();
      if (/^http:\/\//i.test(source)) {
        throw new Error("plain-http sources are not allowed (https only)");
      }
      const isRemoteSource = /^https:\/\//i.test(source);
      if (isRemoteSource && (!input.sha256 || !isHex64(input.sha256))) {
        throw new Error("sha256 (64 hex chars) is required for URL sources");
      }
      if (!isRemoteSource && !source.startsWith("/")) {
        throw new Error("local update sources must be absolute device paths");
      }

      if (await queueAvailable()) {
        if (!updaterReady()) throw new Error(UPDATER_HINT);
        const live = currentState ?? readStateFile();
        if (updateBusy() || rebootBusy() || (live && progressFresh(live))) {
          throw new Error(
            live?.source === "reboot"
              ? "a reboot is already in progress — wait for the host to come back"
              : "an update is already in flight — wait for it to finish",
          );
        }
        const id = `${now()}-${randomUUID().slice(0, 8)}`;
        const request = {
          id,
          source,
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
          ...(input.force ? { force: true } : {}),
        };
        // Drop a leftover request first so the path unit sees the file appear.
        rmSync(requestPath, { force: true });
        const tmp = join(queueDir, `.request-${id}.json`);
        await writeFile(tmp, `${JSON.stringify(request, null, 2)}\n`, "utf8");
        await rename(tmp, requestPath);
        const state: RemoteMaintenanceState = { phase: "queued", id, source, ts: now() };
        await writeJsonAtomic(statusFile, state);
        publish(state);
        return { queued: true, id, mode: "updater" as const };
      }

      // Dev/fallback channel: this process can write the install dir itself.
      if (!deps.allowInProcessUpdate) {
        let writable = false;
        try {
          await mkdir(installDir, { recursive: true });
          writable = true;
        } catch {
          writable = false;
        }
        if (!writable) throw new Error(UPDATER_HINT);
      }
      inFlight = true;
      const id = `${now()}-${randomUUID().slice(0, 8)}`;
      const logLines: string[] = [];
      // Structured step tracking mirrors the root worker channel (agentd ≥ 1.4).
      let lastStepEvent: AgentdUpdateStepEvent | undefined;
      const runningState = (): RemoteMaintenanceState => ({
        phase: "running",
        id,
        source,
        ...(lastStepEvent
          ? {
              step: lastStepEvent.step,
              ...(lastStepEvent.progress ? { progress: { ...lastStepEvent.progress } } : {}),
            }
          : {}),
        ...(logLines.length > 0 ? { logTail: logLines.slice(-6).join("\n") } : {}),
        ts: now(),
      });
      void (async () => {
        try {
          setState(runningState());
          const outcome = await performAgentdUpdate({
            source,
            sha256: input.sha256,
            force: input.force,
            installDir,
            write: (line) => {
              logLines.push(line);
              if (logLines.length > 40) logLines.shift();
              setState(runningState());
            },
            onStep: (event) => {
              lastStepEvent = event;
              setState(runningState());
            },
          });
          if (outcome.ok) {
            const state: RemoteMaintenanceState = {
              phase: "done",
              id,
              source,
              version: outcome.version,
              logTail: logLines.slice(-6).join("\n"),
              ts: now(),
            };
            setState(state);
            await writeJsonAtomic(statusFile, state).catch(() => {});
            deps.requestRestart();
          } else {
            const state: RemoteMaintenanceState = {
              phase: "failed",
              id,
              source,
              error: outcome.error,
              ...(lastStepEvent ? { step: lastStepEvent.step } : {}),
              logTail: logLines.slice(-6).join("\n"),
              ts: now(),
            };
            setState(state);
            await writeJsonAtomic(statusFile, state).catch(() => {});
          }
        } catch (error) {
          const state: RemoteMaintenanceState = {
            phase: "failed",
            id,
            source,
            error: error instanceof Error ? error.message : String(error),
            ...(lastStepEvent ? { step: lastStepEvent.step } : {}),
            ts: now(),
          };
          setState(state);
          await writeJsonAtomic(statusFile, state).catch(() => {});
        } finally {
          inFlight = false;
        }
      })();
      return { queued: true, id, mode: "in-process" as const };
    },

    async checkUpdate(manifestUrl) {
      const response = await fetchFn(manifestUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`manifest fetch failed: HTTP ${response.status}`);
      }
      const manifest = (await response.json()) as {
        agentd?: { version?: unknown; file?: unknown; sha256?: unknown };
      };
      const entry = manifest.agentd;
      if (!entry || typeof entry.version !== "string" || typeof entry.file !== "string") {
        return null;
      }
      return {
        version: entry.version,
        url: new URL(entry.file, manifestUrl).href,
        ...(typeof entry.sha256 === "string" ? { sha256: entry.sha256 } : {}),
      };
    },

    stop() {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };

  // Bootstrap: surface any persisted state (e.g. the "done" written by the
  // updater right before it restarted us) and start the poller.
  syncFromDisk();
  pollTimer = setInterval(syncFromDisk, pollIntervalMs);
  pollTimer.unref?.();

  return maintenance;
}
