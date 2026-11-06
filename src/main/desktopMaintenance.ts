/**
 * Desktop (macOS / Windows) device-maintenance surface — the implementation
 * behind the remoteBridge maintenance actions on a GUI device.
 *
 * Parity with agentd, minus the privilege split: agentd is an unprivileged
 * service that drops a request file for a ROOT systemd oneshot. A desktop app
 * runs as the logged-in user, so the only privilege it needs is the one it
 * already has — writing its own install location. There is no daemon to hand
 * off to, but a process also cannot replace the bundle it is running from, so
 * the swap is delegated to a detached helper (macOS) or to the NSIS installer
 * (Windows), and the NEXT process reports the outcome from `pending.json`.
 *
 * What this module deliberately does NOT do:
 *  - system reboot: macOS needs root or an Apple Events prompt, and rebooting
 *    a machine somebody may be using is out of scope (decision 2026-10-20);
 *  - remote shell (deviceExec): an unsandboxed user shell is a different
 *    threat class than agentd's systemd sandbox — see `execSupported`.
 *
 * Unsigned builds: the release pipeline ships ad-hoc signed bundles, so the
 * download is pinned by sha256 from the release manifest and fetched straight
 * from the origin (the relay stays signaling-only). Gatekeeper never sees a
 * quarantine xattr because our own process wrote the file. The known cost is
 * TCC: macOS keys mic/screen-recording grants to the cdhash, so a version
 * bump asks the user to re-approve — accepted, not worked around.
 */
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
  /** App-data root; this module keeps `desktop-maintenance/` under it. */
  dataDir: string;
  appVersion: () => string;
  /** Absolute path of the running executable (process.execPath). */
  execPath: () => string;
  platform: NodeJS.Platform;
  arch: string;
  /** Sessions with a turn in flight — remote maintenance refuses while > 0. */
  isBusy: () => number;
  /** Electron `app.relaunch()` — schedules a fresh instance after exit. */
  relaunch: () => void;
  /** Electron `app.exit()` — leave without running quit handlers. */
  exit: () => void;
  onStateChange?: (state: RemoteMaintenanceState) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Wait before exiting so the relay ack reaches the wire first. */
  exitDelayMs?: number;
  /** Injectable seams (tests). */
  writableProbe?: (dir: string) => boolean;
  bundlePath?: string;
  downloadDir?: string;
  spawnDetached?: (command: string, args: string[]) => void;
  runCommand?: (command: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;
}

/** A pending/running update record, persisted so the next process can report. */
export interface PendingUpdate {
  id: string;
  fromVersion: string;
  /** Target release version when the console told us (blank = unknown). */
  toVersion: string;
  source: string;
  phase: "pending" | "done" | "failed";
  ts: number;
  /** Backup bundle left on disk for manual rollback (macOS). */
  backup?: string;
  log: string;
  error?: string;
}

/** How long a pending record may sit before the next boot calls it failed. */
export const PENDING_STALE_MS = 15 * 60_000;
/** Progress pushes are throttled — the console re-renders on every one. */
const PROGRESS_THROTTLE_MS = 1_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Compare dotted versions; non-numeric segments compare as 0. */
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

/**
 * Install target for this platform: the `.app` bundle on macOS (walking up
 * from `…/Foo.app/Contents/MacOS/Foo`), the executable's directory on
 * Windows. Returns null when the executable is not inside a bundle.
 */
export function resolveBundlePath(execPath: string, platform: NodeJS.Platform): string | null {
  // Use the TARGET platform's path rules, not the host's: this runs on macOS
  // while reasoning about win32 layouts in tests and vice versa.
  if (platform === "win32") return win32.dirname(execPath);
  const target = posix;
  const parts = target.normalize(execPath).split("/");
  const index = parts.findIndex((part) => part.endsWith(".app"));
  if (index < 0) return null;
  return parts.slice(0, index + 1).join("/") || "/";
}

/**
 * macOS runs apps straight out of a DMG from a randomized read-only mount
 * (`/private/var/folders/…/AppTranslocation/…`). Self-update there can only
 * fail — detect it and tell the user to drag the app out first.
 */
export function isTranslocated(execPath: string): boolean {
  // Translocation is macOS-only and the marker is always a POSIX path segment.
  // Matching with the HOST separator silently returns false when this runs on
  // win32 (tests reason about darwin paths there), so pin it to posix.sep.
  return execPath.includes(`${posix.sep}AppTranslocation${posix.sep}`);
}

/** Manifest entry for this platform → download url + pinned digest. */
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
  // macOS ships both a dmg (humans) and a zip (self-update: `ditto -x -k`
  // preserves the ad-hoc signature, mounting a dmg does not). Only the zip can
  // be applied in place, so a manifest without one means "no self-update for
  // this platform" — returning the dmg here would download 120 MB and then
  // fail at extract time.
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

/** macOS swap script — waits for this process to die, swaps, relaunches. */
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
  /** Report the outcome of a previous update (call once, after app ready). */
  reconcile(): Promise<void>;
  /** Live state for reconnect catch-up pushes. */
  currentState(): RemoteMaintenanceState | null;
  /** Where the module keeps its state (tests + deviceStatus). */
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
      /* status is advisory — never fail an update over it */
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

  /** Stream the release into `<downloads>/<id>` while reporting bytes. */
  const download = async (
    source: string,
    target: string,
    report: (received: number, total?: number) => void,
  ): Promise<void> => {
    await mkdir(dirname(target), { recursive: true });
    if (!/^https:\/\//i.test(source)) {
      // Local staging path (dev / offline installs) — copy, don't fetch.
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
        // Windows: the NSIS installer owns unpack/install/relaunch. Silent +
        // `--updated` (skip the wizard, keep app data) + `--force-run` (start
        // the app when the installer is silently finished).
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

      // macOS: unpack next to the download, then hand the swap to a helper
      // that can outlive this process.
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
      // `ditto` keeps the ad-hoc signature and xattrs intact; a plain copy
      // would break the arm64 code signature and the app would die on launch.
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
    // Desktops never advertise the remote shell — see execSupported.
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
      // Ack first: the caller's response must reach the relay before the
      // process disappears (same order as agentd's 400ms timer).
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

    /**
     * Fold the previous attempt's outcome into a state the console shows.
     * The helper (or installer) restarted us, so "did the version move?" is
     * the only signal available — no supervisor exists to ask.
     */
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
      // The only observable outcome: this process is the freshly installed
      // one. Compare against the version we were on when queuing (the target
      // version is not always known — the console may pass only a URL).
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
      if (!stale) return; // still inside the window — leave it queued
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

/** First `*.app` inside a staging directory (release zips have one root). */
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
