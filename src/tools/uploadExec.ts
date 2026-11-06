/**
 * Node-side rsync upload plumbing for the upload_files tool: flavor probing
 * (GNU progress2 vs openrsync legacy), command building from structured
 * parameters, and the live tracker that parses process output into
 * throttled tool_live "upload" payloads.
 *
 * Node-only (child_process) — the pure output parsers stay in
 * uploadDetect.ts so the renderer can keep importing those.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { JsonObject } from "./types.js";
import {
  parseRsyncFileLine,
  parseRsyncProgressLine,
  parseRsyncStartingLine,
  type RsyncProgressSample,
} from "./uploadDetect.js";

const execFileAsync = promisify(execFile);

/** Long uploads get a relaxed ceiling vs the plain run_shell timeout. */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** tool_live throttle: at most ~8 card patches per second. */
export const UPLOAD_LIVE_THROTTLE_MS = 120;

/** Enhancement flavor; picked by probing the local rsync at runtime. */
export type UploadEnhanceMode = "progress2" | "legacy";

/** Display/progress info shared by the tool handler and the card. */
export type RsyncUploadPlan = {
  /** Display source as the model wrote it. */
  src: string;
  /** Absolute local source path. */
  srcPath: string;
  /** Display destination "host:/path". */
  dest: string;
  /** rsync remote spec "host:/abs/path". */
  destSpec: string;
  excludes: string[];
  delete: boolean;
  dryRun: boolean;
  /** --delete without an .env exclusion — card shows a warning badge. */
  envAtRisk: boolean;
};

/**
 * Probe whether the local rsync understands `--info=progress2` (GNU rsync
 * 3.x). Stock macOS ships openrsync ("rsync version 2.6.9 compatible")
 * which rejects it — those fall back to the legacy --progress enhancement.
 * Cached per rsync invocation token; failures mean "legacy".
 */
const progress2ProbeCache = new Map<string, Promise<boolean>>();
/**
 * Probe whether the local rsync understands `--info=progress2` (GNU rsync
 * 3.x). Stock macOS ships openrsync ("rsync version 2.6.9 compatible")
 * which rejects it — those fall back to the legacy --progress enhancement.
 * Cached per rsync invocation token; failures mean "legacy".
 *
 * Async: the old execFileSync blocked the Electron main process for the
 * full probe (up to 5s timeout) on every first upload_files call.
 */
export function rsyncSupportsProgress2(program: string): Promise<boolean> {
  const cached = progress2ProbeCache.get(program);
  if (cached !== undefined) return cached;
  const probe = execFileAsync(
    program,
    ["--info=progress2", "--version"],
    {
      timeout: 5_000,
      // Console flash guard on Windows (rsync is a console program).
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    },
  )
    .then(() => true)
    .catch(() => false);
  progress2ProbeCache.set(program, probe);
  return probe;
}

/**
 * Windows absolute path in either form a cross-built release sees on macOS:
 * `E:\builds\out`, `E:/builds/out`, or a UNC share `\\host\share`.
 */
function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Quote one shell token for the LOCAL shell that will run the command. */export function shQuote(s: string, platform: NodeJS.Platform = process.platform): string {
  if (s === "") return platform === "win32" ? '""' : "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  if (platform === "win32") {
    // cmd.exe does NOT treat single quotes as quoting, and Windows paths are
    // full of backslashes (never in the safe set above), so every absolute
    // path would otherwise reach rsync/scp wrapped in literal ticks.
    // Double quotes are cmd's only quoting form; `"` cannot appear in a
    // Windows file name, so escaping is a formality for our tokens.
    return `"${s.replace(/"/g, '""')}"`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Validate structured upload_files args and derive the display plan. */
export function planUploadFiles(
  args: JsonObject,
  workspacePath: string,
):
  | { ok: true; plan: RsyncUploadPlan }
  | { ok: false; error: string } {
  const src = args.src;
  const destHost = args.dest_host;
  const destPath = args.dest_path;
  if (typeof src !== "string" || src.trim() === "") {
    return { ok: false, error: 'Invalid arguments: "src" (string) is required.' };
  }
  if (typeof destHost !== "string" || destHost.trim() === "") {
    return { ok: false, error: 'Invalid arguments: "dest_host" (string) is required.' };
  }
  if (typeof destPath !== "string" || !destPath.startsWith("/")) {
    return {
      ok: false,
      error: 'Invalid arguments: "dest_path" must be an absolute path starting with "/".',
    };
  }
  if (args.delete !== undefined && typeof args.delete !== "boolean") {
    return { ok: false, error: 'Invalid arguments: "delete" must be a boolean.' };
  }
  if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") {
    return { ok: false, error: 'Invalid arguments: "dry_run" must be a boolean.' };
  }
  const excludesRaw = args.excludes;
  if (
    excludesRaw !== undefined &&
    (!Array.isArray(excludesRaw) ||
      excludesRaw.some((e) => typeof e !== "string"))
  ) {
    return { ok: false, error: 'Invalid arguments: "excludes" must be an array of strings.' };
  }
  const excludes = (excludesRaw as string[] | undefined) ?? [];

  // `node:path`'s isAbsolute is host-flavoured: on POSIX a Windows path like
  // `E:\builds\out` is "relative", so it silently got prefixed with the
  // workspace root and the backend then built `/Users/…/JellyBot/E:\builds…`.
  // Cross-built Windows uploads are planned on macOS, so recognise the Windows
  // forms explicitly (drive letter or UNC) before falling back to join().
  const srcPath = isAbsolute(src) || isWindowsAbsolutePath(src) ? src : join(workspacePath, src);
  const destSpec = `${destHost}:${destPath}`;
  const del = args.delete === true;
  const envAtRisk =
    del && !excludes.some((e) => e === ".env" || e.includes(".env"));
  return {
    ok: true,
    plan: {
      src,
      srcPath,
      dest: destSpec,
      destSpec,
      excludes,
      delete: del,
      dryRun: args.dry_run === true,
      envAtRisk,
    },
  };
}

/* -------------------------------------------------------------------------
 * Backend selection: rsync when it exists, scp (OpenSSH, ships with Windows)
 * as the Windows fallback.
 * ---------------------------------------------------------------------- */

const rsyncAvailableCache = new Map<string, Promise<boolean>>();

/**
 * Is the local `rsync` runnable at all? Windows has no stock rsync, and the
 * handler must not spawn a command that cannot exist — that surfaced as a raw
 * `'rsync' is not recognized` from cmd.exe (exit 255) instead of a usable
 * fallback. Cached per program token; failures mean "absent".
 */
export function rsyncAvailable(program = "rsync"): Promise<boolean> {
  const cached = rsyncAvailableCache.get(program);
  if (cached !== undefined) return cached;
  const probe = execFileAsync(program, ["--version"], {
    timeout: 5_000,
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  })
    .then(() => true)
    .catch(() => false);
  rsyncAvailableCache.set(program, probe);
  return probe;
}

export type RsyncProgramProbe = {
  program: string;
  progress2Supported: boolean;
};

/** Probe bundled candidates before PATH; a broken bundle must not mask system rsync. */
export async function probeRsyncPrograms(
  programs: string[],
  probe: (program: string) => Promise<{ available: boolean; progress2Supported: boolean }> = async (program) => {
    const [available, progress2Supported] = await Promise.all([
      rsyncAvailable(program),
      rsyncSupportsProgress2(program),
    ]);
    return { available, progress2Supported };
  },
): Promise<RsyncProgramProbe | null> {
  for (const program of new Set(programs)) {
    const result = await probe(program);
    if (result.available) return { program, progress2Supported: result.progress2Supported };
  }
  return null;
}

/** Test seam: forget probed capabilities (rsync presence + progress2). */
export function resetUploadProbeCache(): void {
  rsyncAvailableCache.clear();
  progress2ProbeCache.clear();
}

export type UploadBackend =
  | { kind: "rsync"; mode: UploadEnhanceMode }
  | { kind: "scp" }
  | { kind: "error"; error: string };

/**
 * Pick the transfer backend. Pure so the decision (and every refusal) is
 * unit-testable without spawning anything.
 *
 * scp can only copy: `--delete`, `--exclude` and `-n` have no equivalent, so
 * a fallback request that relies on them must fail loudly instead of silently
 * dropping the flags (a silent `--delete` drop is a correctness bug; a silent
 * `--exclude .env` drop is a secret leak).
 */
export function chooseUploadBackend(input: {
  platform: NodeJS.Platform;
  plan: RsyncUploadPlan;
  rsyncAvailable: boolean;
  progress2Supported: boolean;
}): UploadBackend {
  if (input.rsyncAvailable) {
    return { kind: "rsync", mode: input.progress2Supported ? "progress2" : "legacy" };
  }
  if (input.platform !== "win32") {
    return {
      kind: "error",
      error:
        "rsync was not found on this machine — install it (e.g. `brew install rsync`) and retry.",
    };
  }
  const plan = input.plan;
  const unsupported = [
    plan.delete ? "--delete" : "",
    plan.dryRun ? "-n (dry run)" : "",
    plan.excludes.length > 0 ? "--exclude" : "",
  ].filter(Boolean);
  if (unsupported.length > 0) {
    return {
      kind: "error",
      error:
        `rsync is not installed, and the scp fallback cannot do ${unsupported.join(", ")}. ` +
        "Install rsync (scoop install rsync / cwRsync) to use those options.",
    };
  }
  return { kind: "scp" };
}

/**
 * scp fallback command line. `-r` for directories, `-p` to keep mtimes, and
 * BatchMode so a missing key fails instead of hanging on a password prompt.
 */
export function buildScpCommand(
  plan: RsyncUploadPlan,
  platform: NodeJS.Platform = process.platform,
): string {
  const flags = ["scp", "-r", "-p", "-o", "BatchMode=yes"];
  flags.push(shQuote(plan.srcPath, platform), shQuote(plan.destSpec, platform));
  return flags.join(" ");
}

/** Split an rsync/scp remote spec (`user@host:/abs/path`) into its halves. */
export function parseDestSpec(spec: string): { host: string; path: string } | null {
  const at = spec.indexOf(":");
  if (at <= 0) return null;
  const host = spec.slice(0, at);
  const path = spec.slice(at + 1);
  if (!host || !path.startsWith("/")) return null;
  return { host, path };
}

/**
 * Local byte/file count for the fallback progress bar (scp prints no
 * progress when stdout is not a tty). Symlinks are counted by their target
 * size, matching what scp transfers; unreadable entries are skipped.
 */
export async function localUploadBytes(
  path: string,
): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (p: string): Promise<void> => {
    try {
      const info = await stat(p);
      if (info.isDirectory()) {
        const entries = await readdir(p);
        for (const entry of entries) await walk(join(p, entry));
        return;
      }
      bytes += info.size;
      files += 1;
    } catch {
      /* unreadable → not transferred */
    }
  };
  await walk(path);
  return { bytes, files };
}

/** Human transfer rate, matching rsync's own "4.90MB/s" shape. */
export function formatRate(bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  const units = ["B/s", "kB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(2)}${units[unit]}`;
}

/**
 * One progress sample for the scp fallback: bytes actually on disk at the
 * destination (polled over SSH) against the local total.
 */
export function scpProgressSample(input: {
  localBytes: number;
  remoteBytes: number;
  elapsedMs: number;
}): {
  percent: number;
  bytesSent: number;
  bytesTotal: number;
  speed: string | null;
  etaSeconds: number | null;
} {
  const bytesTotal = Math.max(0, input.localBytes);
  const bytesSent = Math.max(0, Math.min(input.remoteBytes, bytesTotal || input.remoteBytes));
  const percent = bytesTotal > 0 ? Math.min(100, (bytesSent / bytesTotal) * 100) : 0;
  const elapsedSec = Math.max(0.001, input.elapsedMs / 1000);
  // Average rate: scp gives no incremental counters, and polling lags behind
  // the real transfer, so an instantaneous delta would jitter wildly.
  const rate = bytesSent / elapsedSec;
  const speed = formatRate(rate);
  const etaSeconds =
    bytesTotal > bytesSent && rate > 0 ? Math.round((bytesTotal - bytesSent) / rate) : null;
  return { percent, bytesSent, bytesTotal, speed, etaSeconds };
}

/** SSH probe for the destination size — `du -sb` covers files and dirs. */
export function buildRemoteSizeProbe(
  host: string,
  destPath: string,
): { command: string; args: string[] } {
  const quoted = shQuote(destPath, "darwin");
  return {
    command: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, `du -sb ${quoted} 2>/dev/null || echo 0`],
  };
}

/** Parse `du -sb` output ("1234\t/path") into a byte count (0 when absent). */
export function parseDuBytes(stdout: string): number {
  const first = stdout.trim().split(/\s+/)[0] ?? "";
  const value = Number(first);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Run the SSH size probe; any failure means "no bytes at the destination yet". */
export async function probeRemoteBytes(probe: {
  command: string;
  args: string[];
}): Promise<number> {
  try {
    const { stdout } = await execFileAsync(probe.command, probe.args, {
      timeout: 8_000,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });
    return parseDuBytes(String(stdout));
  } catch {
    return 0;
  }
}

/** Cygwin rsync treats a drive-letter colon as a remote-host separator. */
export function rsyncLocalPath(src: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return src;
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(src);
  if (drive) return `/cygdrive/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}`;
  return src.replaceAll("\\", "/");
}

/**
 * Build the enhanced rsync command line. mode "progress2" injects
 * `--info=progress2` (whole-transfer bar); "legacy" (openrsync) injects
 * `--progress -v` (per-file runs, bar driven by file count). Both append
 * `--out-format=%n|%b|%l` for per-file events (%l = true file size).
 */
export function buildRsyncCommand(
  plan: RsyncUploadPlan,
  mode: UploadEnhanceMode,
  platform: NodeJS.Platform = process.platform,
  program = "rsync",
): string {
  const flags = [shQuote(program, platform), "-az"];
  if (mode === "progress2") flags.push("--info=progress2");
  else flags.push("--progress", "-v");
  if (plan.delete) flags.push("--delete");
  if (plan.dryRun) flags.push("-n");
  for (const e of plan.excludes) flags.push(`--exclude=${shQuote(e, platform)}`);
  flags.push(`--out-format=${shQuote("%n|%b|%l", platform)}`);
  flags.push(shQuote(rsyncLocalPath(plan.srcPath, platform), platform), shQuote(plan.destSpec, platform));
  return flags.join(" ");
}

/**
 * Live rsync-upload tracker for the renderer's upload card. Feeds on
 * execShellProcess chunks and emits throttled tool_live events.
 *
 * progress2 mode (GNU 3.x): `--info=progress2` lines are whole-transfer
 * snapshots (percent/bytes/speed/ETA + xfr#/to-chk) — used as-is.
 *
 * legacy mode (openrsync / rsync 2.x): `--progress` emits one run of
 * per-file progress lines per file; the (xfer#N, to-check=a/b) completion
 * line finalizes each file. The bar blends file-count progress with the
 * in-flight file's own byte percent (a single large file keeps moving);
 * the readout accumulates completed bytes plus the current file's partial
 * bytes and shows the current file's rate/ETA.
 */
export class UploadLiveTracker {
  private buffer = "";
  private sample: RsyncProgressSample | null = null;
  private recentFiles: { name: string; bytes: number }[] = [];
  private filesFromXfr = 0;
  private filesTotal: number | null = null;
  private bytesAccum = 0;
  /**
   * True when the latest progress sample is a completion line (xfr#) that
   * filesDoneCount()/bytesAccum already count — mid-file lines are NOT
   * counted yet, so their percent/bytes blend into the live readout.
   */
  private sampleCounted = false;
  private phase: "connecting" | "transferring" = "connecting";
  private lastEmitAt = 0;
  private emitted = false;

  constructor(
    private readonly info: RsyncUploadPlan,
    private readonly mode: UploadEnhanceMode,
    private readonly emitLive: (payload: JsonObject) => void,
  ) {}

  /** Feed one decoded stdout chunk. */
  onChunk(chunk: string): void {
    this.buffer += chunk;
    const lastTerm = Math.max(this.buffer.lastIndexOf("\r"), this.buffer.lastIndexOf("\n"));
    if (lastTerm < 0) return;
    const segments = this.buffer.slice(0, lastTerm).split(/[\r\n]+/);
    this.buffer = this.buffer.slice(lastTerm + 1);
    let dirty = false;
    for (const raw of segments) {
      const seg = raw.trim();
      if (!seg) continue;
      const starting = parseRsyncStartingLine(seg);
      if (starting !== null) {
        this.filesTotal = starting;
        dirty = true;
        continue;
      }
      const progress = parseRsyncProgressLine(seg);
      if (progress) {
        this.sample = progress;
        // Completion lines carry xfr# — the line's byte count is that
        // file's full transfer; legacy mode accumulates it. xfr# is the
        // authoritative file counter (out-format lines would double-count).
        if (progress.filesTransferred !== null) {
          this.filesFromXfr = Math.max(this.filesFromXfr, progress.filesTransferred);
          if (this.mode === "legacy") this.bytesAccum += progress.bytesSent;
          this.sampleCounted = true;
          if (progress.check) this.filesTotal ??= progress.check.total;
        } else {
          // Mid-file run: the current file's partial bytes are not in
          // bytesAccum yet — emit() adds them on top (single large file
          // would otherwise show 0% until the file lands).
          this.sampleCounted = false;
        }
        this.phase = "transferring";
        dirty = true;
        continue;
      }
      const file = parseRsyncFileLine(seg);
      if (file) {
        this.recentFiles.push({ name: file.name, bytes: file.bytes });
        if (this.recentFiles.length > 40) this.recentFiles.shift();
        this.phase = "transferring";
        dirty = true;
      }
    }
    if (!dirty) return;
    const now = Date.now();
    if (now - this.lastEmitAt < UPLOAD_LIVE_THROTTLE_MS) return;
    this.lastEmitAt = now;
    this.emit();
  }

  /** Final unthrottled snapshot (process exit) so the card lands on 100%. */
  flush(): void {
    if (this.emitted) this.emit();
  }

  /** Did we ever stream anything (guards the final flush)? */
  get streamed(): boolean {
    return this.emitted;
  }

  private emit(): void {
    this.emitted = true;
    const sample = this.sample;
    // progress2: percent is the whole-transfer percent. legacy: no total
    // byte count exists — drive the bar by file count blended with the
    // in-flight file's own byte progress, so a single large file still
    // visibly moves instead of sitting at 0% until it lands.
    const inFlight =
      this.mode === "legacy" && !this.sampleCounted && sample !== null;
    const inFlightFraction = inFlight
      ? Math.max(0, Math.min(100, sample.percent)) / 100
      : 0;
    const percent =
      this.mode === "progress2"
        ? (sample?.percent ?? 0)
        : this.filesTotal !== null && this.filesTotal > 0
          ? Math.min(
              100,
              ((this.filesDoneCount() + inFlightFraction) / this.filesTotal) * 100,
            )
          : (sample?.percent ?? 0);
    const bytesSent =
      this.mode === "progress2"
        ? (sample?.bytesSent ?? 0)
        : this.bytesAccum + (inFlight ? sample.bytesSent : 0);
    const bytesTotal =
      this.mode === "progress2" && percent > 0
        ? Math.round(bytesSent / (percent / 100))
        : undefined;
    this.emitLive({
      phase: this.phase,
      src: this.info.src,
      dest: this.info.dest,
      excludes: this.info.excludes,
      ...(this.info.envAtRisk ? { envAtRisk: true } : {}),
      percent: Math.round(percent * 10) / 10,
      bytesSent,
      ...(bytesTotal !== undefined ? { bytesTotal } : {}),
      ...(sample?.speed ? { speed: sample.speed } : {}),
      ...(sample && sample.etaSeconds !== null ? { etaSeconds: sample.etaSeconds } : {}),
      ...(this.filesTotal !== null ? { filesTotal: this.filesTotal } : {}),
      filesDone: this.filesDoneCount(),
      recentFiles: this.recentFiles,
    });
  }

  /** xfr# count, falling back to out-format line count if none arrived. */
  private filesDoneCount(): number {
    return this.filesFromXfr > 0 ? this.filesFromXfr : this.recentFiles.length;
  }
}
