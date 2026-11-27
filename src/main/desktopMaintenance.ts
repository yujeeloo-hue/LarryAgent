import { createHash, randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, uptime as osUptime } from "node:os";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import { once } from "node:events";
import type {
  RemoteDeviceMaintenance,
  RemoteMaintenanceState,
} from "../remote/remoteBridge.js";
import { writeJsonAtomic } from "../agentd/atomicJson.js";

export interface DesktopMaintenanceDeps {
  dataDir: string;
  appVersion: () => string;
  execPath: () => string;
  platform: NodeJS.Platform;
  arch: string;
  isBusy: () => number;
  relaunch: () => void;
  exit: () => void;
  onStateChange?: (state: RemoteMaintenanceState) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
  exitDelayMs?: number;
  writableProbe?: (dir: string) => boolean;
  bundlePath?: string;
  downloadDir?: string;
  spawnDetached?: (command: string, args: string[]) => void;
  runCommand?: (command: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;
}

export interface PendingUpdate {
  id: string;
  fromVersion: string;
  toVersion: string;
  source: string;
  phase: "pending" | "done" | "failed";
  ts: number;
  backup?: string;
  log: string;
  error?: string;
}

export const PENDING_STALE_MS = 15 * 60_000;
const PROGRESS_THROTTLE_MS = 1_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = Number.isFinite(left[i] as number) ? (left[i] as number) : 0;
    const r = Number.isFinite(right[i] as number) ? (right[i] as number) : 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export function resolveBundlePath(execPath: string, platform: NodeJS.Platform): string | null {
  if (platform === "win32") return win32.dirname(execPath);
  const target = posix;
  const parts = target.normalize(execPath).split("/");
  const index = parts.findIndex((part) => part.endsWith(".app"));
  if (index < 0) return null;
  return parts.slice(0, index + 1).join("/") || "/";
}

export function isTranslocated(execPath: string): boolean {
  return execPath.includes(`${posix.sep}AppTranslocation${posix.sep}`);
}

export function parseManifestEntry(
  manifest: unknown,
  platform: NodeJS.Platform,
): { version: string; file: string; sha256?: string } | null {
  if (!manifest || typeof manifest !== "object") return null;
  const record = manifest as Record<string, unknown>;
  const key = platform === "darwin" ? "mac" : platform === "win32" ? "win" : "";
  if (!key) return null;
  const entry = record[key];
  if (!entry || typeof entry !== "object") return null;
  const fields = entry as Record<string, unknown>;
  if (typeof fields.version !== "string" || !fields.version) return null;
  const isZip = (value: unknown): value is string => typeof value === "string" && /\.zip$/i.test(value);
  const file =
    platform === "darwin"
      ? [fields.zipFile, fields.file].find(isZip) ?? ""
      : typeof fields.file === "string"
        ? fields.file
        : "";
  if (!file) return null;
  const sha =
    platform === "darwin" && typeof fields.zipSha256 === "string"
      ? fields.zipSha256
      : typeof fields.sha256 === "string"
        ? fields.sha256
        : "";
  return { version: fields.version, file, ...(sha ? { sha256: sha.toLowerCase() } : {}) };
}

export const MAC_APPLY_SCRIPT = `#!/bin/sh
# Larry Agent self-update helper (generated; recreated on every update).
# Args: <pid> <staged-app> <target-app> <backup-app> <trash-dir> <log>
set -u
PID="$1"; SRC="$2"; TARGET="$3"; BACKUP="$4"; TRASH="$5"; LOG="$6"
log() { printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG"; }
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 1500 ]; then log "timed out waiting for pid $PID"; exit 1; fi
  sleep 0.2
done
log "app exited; swapping bundle"
if [ -e "$BACKUP" ]; then
  mkdir -p "$TRASH" 2>/dev/null
  mv "$BACKUP" "$TRASH/$(basename "$BACKUP").$(date +%s)" 2>/dev/null && log "old backup moved to Trash"
fi
if ! mv "$TARGET" "$BACKUP"; then
  log "failed to move the current bundle aside (not writable?)"
  exit 1
fi
if ! /usr/bin/ditto "$SRC" "$TARGET"; then
  log "copy failed — rolling back"
  rm -rf "$TARGET"
  mv "$BACKUP" "$TARGET"
  exit 1
fi
rm -rf "$SRC"
log "swap ok; relaunching"
/usr/bin/open -a "$TARGET"
`;

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface DesktopMaintenance extends RemoteDeviceMaintenance {
  reconcile(): Promise<void>;
  currentState(): RemoteMaintenanceState | null;
  stateDir(): string;
}

export function createDesktopMaintenance(deps: DesktopMaintenanceDeps): DesktopMaintenance {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const exitDelayMs = deps.exitDelayMs ?? 400;
  const root = join(deps.dataDir, "desktop-maintenance");
  const statusFile = join(root, "current.json");
  const pendingFile = join(root, "pending.json");
  const helperLog = join(root, "helper.log");
  const downloadsDir = deps.downloadDir ?? join(root, "downloads");
  const trashDir = join(homedir(), ".Trash");

  let currentState: RemoteMaintenanceState | null = null;
  let inFlight = false;
  let lastProgressPush = 0;

  const setState = (state: RemoteMaintenanceState): void => {
    currentState = state;
    void writeJsonAtomic(statusFile, state).catch(() => {
    });
    deps.onStateChange?.(state);
  };

  const pushState = (state: RemoteMaintenanceState, force = false): void => {
    const at = now();
    if (!force && at - lastProgressPush < PROGRESS_THROTTLE_MS) return;
    lastProgressPush = at;
    setState(state);
  };

  const bundlePath = (): string | null =>
    deps.bundlePath ?? resolveBundlePath(deps.execPath(), deps.platform);

  const writableProbe =
    deps.writableProbe ??
    ((dir: string): boolean => {
      const probe = join(dir, `.larry-write-probe-${randomUUID().slice(0, 8)}`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(probe, "");
        return true;
      } catch {
        return false;
      } finally {
        void rm(probe, { force: true }).catch(() => {});
      }
    });

  let pendingCache: PendingUpdate | null = null;
  const readPending = (): PendingUpdate | null => pendingCache;

  const savePending = async (record: PendingUpdate): Promise<void> => {
    pendingCache = record;
    await writeJsonAtomic(pendingFile, record);
  };

  const runCommand = async (
    command: string,
    args: string[],
  ): Promise<{ code: number | null; stderr: string }> => {
    if (deps.runCommand) return deps.runCommand(command, args);
    return await new Promise((resolvePromise) => {
      const child = nodeSpawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", () => resolvePromise({ code: null, stderr: "spawn failed" }));
      child.on("close", (code) => resolvePromise({ code, stderr }));
    });
  };

  const spawnDetached = (command: string, args: string[]): void => {
    if (deps.spawnDetached) {
      deps.spawnDetached(command, args);
      return;
    }
    const child = nodeSpawn(command, args, { detached: true, stdio: "ignore" });
    child.unref?.();
  };

  const download = async (
    source: string,
    target: string,
    report: (received: number, total?: number) => void,
  ): Promise<void> => {
    await mkdir(dirname(target), { recursive: true });
    if (!/^https:\/\//i.test(source)) {
      await rm(target, { force: true });
      await new Promise<void>((resolvePromise, reject) => {
        const read = createReadStream(source);
        const write = createWriteStream(target);
        read.on("error", reject);
        write.on("error", reject);
        write.on("finish", () => resolvePromise());
        read.pipe(write);
      });
      report(1);
      return;
    }
    const response = await fetchFn(source, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status}`);
    }
    const total = Number(response.headers.get("content-length") ?? "") || undefined;
    const write = createWriteStream(target);
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (!write.write(Buffer.from(value))) await once(write, "drain");
      report(received, total);
    }
    write.end();
    await once(write, "finish");
  };

  const fail = (id: string, source: string, error: string, step?: RemoteMaintenanceState["step"]): void => {
    inFlight = false;
    const state: RemoteMaintenanceState = {
      phase: "failed",
      id,
      source,
      error,
      ...(step ? { step } : {}),
      ts: now(),
    };
    setState(state);
    void savePending({
      id,
      fromVersion: deps.appVersion(),
      toVersion: "",
      source,
      phase: "failed",
      ts: now(),
      log: helperLog,
      error,
    }).catch(() => {});
  };

  const runUpdate = async (input: {
    source: string;
    sha256?: string;
    force?: boolean;
    version?: string;
  }): Promise<void> => {
    const id = `${now()}-${randomUUID().slice(0, 8)}`;
    const source = input.source;
    const fromVersion = deps.appVersion();
    const toVersion = input.version?.trim() ?? "";
    const workDir = join(downloadsDir, id);
    const isMac = deps.platform === "darwin";
    const packageName = isMac ? "release.zip" : "release.exe";
    const packagePath = join(workDir, packageName);
    let step: NonNullable<RemoteMaintenanceState["step"]> = "download";
    const report = (received: number, total?: number): void => {
      pushState({
        phase: "running",
        id,
        source,
        step,
        progress: {
          receivedBytes: received,
          ...(total ? { totalBytes: total } : {}),
          ...(total ? { pct: Math.min(100, Math.round((received / total) * 100)) } : {}),
        },
        ts: now(),
      });
    };

    try {
      setState({ phase: "running", id, source, step, ts: now() });
      await download(source, packagePath, report);

      step = "verify";
      setState({ phase: "running", id, source, step, ts: now() });
      if (input.sha256) {
        const actual = await hashFile(packagePath);
        if (actual !== input.sha256.toLowerCase()) {
          await rm(workDir, { recursive: true, force: true });
          fail(id, source, `sha256 mismatch (got ${actual.slice(0, 12)}…, expected ${input.sha256.slice(0, 12)}…)`, "verify");
          return;
        }
      }

      if (!isMac) {
        step = "install";
        setState({ phase: "running", id, source, step, ts: now() });
        await savePending({
          id,
          fromVersion,
          toVersion,
          source,
          phase: "pending",
          ts: now(),
          log: helperLog,
        });
        spawnDetached(packagePath, ["/S", "--updated", "--force-run"]);
        setTimeout(() => deps.exit(), exitDelayMs);
        return;
      }

      step = "extract";
      setState({ phase: "running", id, source, step, ts: now() });
      const stagingDir = join(workDir, "staging");
      await mkdir(stagingDir, { recursive: true });
      const unzip = await runCommand("/usr/bin/ditto", ["-x", "-k", packagePath, stagingDir]);
      if (unzip.code !== 0) {
        await rm(workDir, { recursive: true, force: true });
        fail(id, source, `unzip failed: ${unzip.stderr.trim() || `exit ${unzip.code}`}`, "extract");
        return;
      }
      const stagedApp = await findAppBundle(stagingDir);
      const target = bundlePath();
      if (!stagedApp || !target) {
        await rm(workDir, { recursive: true, force: true });
        fail(id, source, "staged release has no .app bundle", "extract");
        return;
      }

      step = "install";
      setState({ phase: "running", id, source, step, ts: now() });
      const helperPath = join(root, "apply-update.sh");
      await writeFile(helperPath, MAC_APPLY_SCRIPT, "utf8");
      await chmod(helperPath, 0o700);
      const backup = `${target}.bak-${fromVersion}`;
      await savePending({
        id,
        fromVersion,
        toVersion,
        source,
        phase: "pending",
        ts: now(),
        backup,
        log: helperLog,
      });
      spawnDetached("/bin/sh", [
        helperPath,
        String(process.pid),
        stagedApp,
        target,
        backup,
        trashDir,
        helperLog,
      ]);
      setTimeout(() => deps.exit(), exitDelayMs);
    } catch (error) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      fail(id, source, error instanceof Error ? error.message : String(error), step);
    }
  };

  return {
    execSupported: false,

    status() {
      const target = bundlePath();
      const pending = readPending();
      const version = deps.appVersion();
      return {
        agent: "desktop",
        version,
        pid: process.pid,
        hostname: hostname(),
        uptimeSec: Math.floor(osUptime()),
        processUptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: `${deps.platform} ${deps.arch}`,
        supervised: "electron",
        installDir: target ?? "",
        bundleWritable: target ? writableProbe(dirname(target)) : false,
        translocated: isTranslocated(deps.execPath()),
        backupBundle: pending?.backup ?? null,
        channel:
          deps.platform === "darwin" || deps.platform === "win32"
            ? deps.platform === "darwin"
              ? "mac-zip"
              : "win-nsis"
            : null,
        maintenance: currentState,
      };
    },

    currentState() {
      return currentState;
    },

    stateDir() {
      return root;
    },

    restart() {
      const running = deps.isBusy();
      if (running > 0) {
        throw new Error(
          `a turn is in flight in ${running} session${running === 1 ? "" : "s"} — wait for it to finish before restarting`,
        );
      }
      setTimeout(() => {
        try {
          deps.relaunch();
        } finally {
          deps.exit();
        }
      }, exitDelayMs);
      return { restarting: true, supervisor: "electron" };
    },

    reboot() {
      throw new Error(
        "system reboot is not supported on desktop devices — use Restart to relaunch the app",
      );
    },

    async update(input) {
      if (inFlight) throw new Error("an update is already in flight — wait for it to finish");
      const source = input.source.trim();
      if (/^http:\/\//i.test(source)) {
        throw new Error("plain-http sources are not allowed (https only)");
      }
      const remote = /^https:\/\//i.test(source);
      if (remote && (!input.sha256 || !isHex64(input.sha256))) {
        throw new Error("sha256 (64 hex chars) is required for URL sources");
      }
      if (!remote && !isAbsolute(source)) {
        throw new Error("local update sources must be absolute device paths");
      }
      const execPath = deps.execPath();
      if (isTranslocated(execPath)) {
        throw new Error(
          "the app is running from a read-only DMG (App Translocation) — drag it into Applications and relaunch before updating",
        );
      }
      const target = bundlePath();
      if (!target) throw new Error("cannot resolve the app bundle path on this device");
      if (!writableProbe(dirname(target))) {
        throw new Error(
          "the install location is not writable by this user (machine-wide install) — update manually with the installer",
        );
      }
      const running = deps.isBusy();
      if (running > 0) {
        throw new Error(
          `a turn is in flight in ${running} session${running === 1 ? "" : "s"} — wait for it to finish before updating`,
        );
      }

      inFlight = true;
      void runUpdate({
        source,
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        ...(input.force ? { force: true } : {}),
        ...(input.version ? { version: input.version } : {}),
      });
      return { queued: true, id: `desktop-${now()}`, mode: "in-process" as const };
    },

    async checkUpdate(manifestUrl) {
      const response = await fetchFn(manifestUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`manifest fetch failed: HTTP ${response.status}`);
      const manifest = (await response.json()) as unknown;
      const entry = parseManifestEntry(manifest, deps.platform);
      if (!entry) return null;
      return {
        version: entry.version,
        url: new URL(entry.file, manifestUrl).href,
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      };
    },

    async reconcile() {
      const pending = await readJson<PendingUpdate>(pendingFile);
      pendingCache = pending;
      if (!pending) {
        const previous = await readJson<RemoteMaintenanceState>(statusFile);
        if (previous) currentState = previous;
        return;
      }
      if (pending.phase !== "pending") {
        currentState = {
          phase: pending.phase,
          id: pending.id,
          source: pending.source,
          ...(pending.error ? { error: pending.error } : {}),
          ts: pending.ts,
        };
        return;
      }
      const version = deps.appVersion();
      const moved =
        version !== pending.fromVersion ||
        (pending.toVersion ? compareVersions(version, pending.toVersion) >= 0 : false);
      const stale = now() - pending.ts > PENDING_STALE_MS;
      if (moved) {
        const done: PendingUpdate = { ...pending, phase: "done", ts: now() };
        await savePending(done);
        setState({ phase: "done", id: pending.id, source: pending.source, version, ts: now() });
        return;
      }
      if (!stale) return;
      const failed: PendingUpdate = {
        ...pending,
        phase: "failed",
        ts: now(),
        error: `release did not install (still on ${version}) — see helper.log`,
      };
      await savePending(failed);
      setState({
        phase: "failed",
        id: pending.id,
        source: pending.source,
        ...(failed.error ? { error: failed.error } : {}),
        ts: now(),
      });
    },
  };
}

async function findAppBundle(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const bundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    return bundle ? join(dir, bundle.name) : null;
  } catch {
    return null;
  }
}

export function isDesktopChannel(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}
