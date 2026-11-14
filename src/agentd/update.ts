/**
 * `agentd update` / `agentd rollback` — release switching for the /opt install.
 *
 * Layout: /opt/jellybot-agentd/<version>/ (release tree) +
 * /opt/jellybot-agentd/current → symlink (systemd ExecStart target) +
 * /opt/jellybot-agentd/previous → one-step rollback target.
 *
 * update <url-or-path> [--sha256 <hex>] [--install-dir <dir>] [--force]:
 *   download/copy → sha256 verify → extract to a staging dir → pre-switch
 *   smoke (`agentd version` with the vendored Node) → move into
 *   <install-dir>/<version> → switch `current` (old target → `previous`) →
 *   refresh systemd units (root only) → restart the service when running as
 *   root (else print the command).
 *
 * The core (`performAgentdUpdate`) is shared with the root updater worker
 * (updaterWorker.ts — the remote updateDevice path), so the CLI and the
 * console-driven flow execute byte-for-byte the same steps.
 *
 * v1 distribution is SSH-explicit (no auto-update channel).
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  AGENTD_REBOOT_PATH_UNIT,
  AGENTD_UPDATER_PATH_UNIT,
  resolveAgentdVersion,
} from "./config.js";

const DEFAULT_INSTALL_DIR = "/opt/jellybot-agentd";
const SERVICE_NAME = "jellybot-agentd";
const SYSTEMD_DIR = "/etc/systemd/system";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): 1 {
  process.stderr.write(`✖ ${message}\n`);
  return 1;
}

function parseArgs(args: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const valueFlags = new Set(["sha256", "install-dir"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (valueFlags.has(name) && next && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function resolveInstallDir(flags: Record<string, string | true>): string {
  const flag = typeof flags["install-dir"] === "string" ? flags["install-dir"] : "";
  return (
    flag ||
    process.env.JELLYBOT_AGENTD_INSTALL_DIR?.trim() ||
    DEFAULT_INSTALL_DIR
  );
}

/** Resolve the effective install dir for library callers (worker/maintenance). */
export function defaultInstallDir(): string {
  return (
    process.env.JELLYBOT_AGENTD_INSTALL_DIR?.trim() || DEFAULT_INSTALL_DIR
  );
}

/** systemctl restart when root; returns true when the service was restarted. */
function restartService(): boolean {
  const result = spawnSync("systemctl", ["restart", SERVICE_NAME], {
    stdio: "inherit",
  });
  if (result.error) {
    log(`(systemctl unavailable: ${result.error.message})`);
    return false;
  }
  return result.status === 0;
}

/**
 * Refresh systemd units shipped with the freshly installed release (root
 * only). Keeps `jellybot-agentd.service` and the root-updater units current
 * across console-driven updates — the one-time `install-updater` bootstrap
 * never has to be repeated. Only writes when content differs.
 */
function syncSystemdUnits(
  releaseRoot: string,
  write: (message: string) => void,
): void {
  if (process.getuid?.() !== 0) return;
  const shipped = join(releaseRoot, "systemd");
  if (!existsSync(shipped) || !existsSync(SYSTEMD_DIR)) return;
  let changed = false;
  let updaterUnits = false;
  let rebootUnits = false;
  for (const name of readdirSync(shipped)) {
    if (!name.endsWith(".service") && !name.endsWith(".path")) continue;
    const source = join(shipped, name);
    const target = join(SYSTEMD_DIR, name);
    try {
      if (existsSync(target) && readFileSync(target, "utf8") === readFileSync(source, "utf8")) {
        continue;
      }
      copyFileSync(source, target);
      chmodSync(target, 0o644);
      changed = true;
      if (name === AGENTD_UPDATER_PATH_UNIT || name === "jellybot-agentd-update.service") {
        updaterUnits = true;
      }
      if (name === AGENTD_REBOOT_PATH_UNIT || name === "jellybot-agentd-reboot.service") {
        rebootUnits = true;
      }
      write(`systemd unit refreshed: ${name}`);
    } catch (error) {
      write(`⚠ could not refresh ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!changed) return;
  const reload = spawnSync("systemctl", ["daemon-reload"]);
  if (reload.error || reload.status !== 0) {
    write(`⚠ systemctl daemon-reload failed — units activate on next reload`);
  }
  if (updaterUnits) {
    // Self-heal the watcher. Do not restart the path unit from inside the
    // oneshot it triggered — that can queue a second start of this process
    // while request.json is still in place. daemon-reload plus the device
    // deleting the request before the next write is enough to re-arm.
    spawnSync("systemctl", ["enable", AGENTD_UPDATER_PATH_UNIT]);
    write(`updater path unit enabled (${AGENTD_UPDATER_PATH_UNIT})`);
  }
  if (rebootUnits) {
    const enable = spawnSync("systemctl", ["enable", "--now", AGENTD_REBOOT_PATH_UNIT]);
    write(
      enable.status === 0
        ? `reboot path unit enabled (${AGENTD_REBOOT_PATH_UNIT})`
        : `⚠ could not enable ${AGENTD_REBOOT_PATH_UNIT}`,
    );
  }
}

/**
 * Pre-switch smoke: run `<release>/bin/agentd version` with the release's
 * vendored Node. Returns null when the check cannot run on this host (e.g.
 * cross-arch staging on a Mac) — treated as "skip", not "fail".
 */
function smokeRelease(targetDir: string, expectedVersion: string): string | null {
  const nodeBin = join(targetDir, "lib", "node", "bin", "node");
  const entry = join(targetDir, "lib", "agentd.mjs");
  if (!existsSync(nodeBin) || !existsSync(entry)) {
    return `release is missing ${existsSync(nodeBin) ? entry : nodeBin}`;
  }
  const result = spawnSync(nodeBin, [entry, "version"], { encoding: "utf8" });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOEXEC" || code === "EPERM" || code === "EACCES") {
      log(`⚠ smoke skipped — cannot execute ${nodeBin} on this host (${code})`);
      return null;
    }
    return `smoke failed to start: ${result.error.message}`;
  }
  if (result.status !== 0) {
    return `smoke exited ${result.status}: ${(result.stderr ?? "").trim()}`;
  }
  const printed = (result.stdout ?? "").trim();
  if (!printed.includes(expectedVersion)) {
    return `smoke printed "${printed}" (expected version ${expectedVersion})`;
  }
  return null;
}

export type AgentdUpdateStep =
  | "download"
  | "verify"
  | "extract"
  | "smoke"
  | "install"
  | "switch"
  | "units"
  | "restart";

export interface AgentdUpdateProgress {
  receivedBytes: number;
  /** Absent when the server sends no usable Content-Length. */
  totalBytes?: number;
  bytesPerSec?: number;
  /** 0–100; absent when the transfer size is unknown. */
  pct?: number;
}

export interface AgentdUpdateStepEvent {
  step: AgentdUpdateStep;
  /** Byte-level progress (only meaningful while step === "download"). */
  progress?: AgentdUpdateProgress;
}

/** No new bytes for this long during a download → abort with a clear error. */
export const DEFAULT_DOWNLOAD_STALL_MS = 30_000;

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface LoadTarballOpts {
  fetchFn?: typeof fetch;
  stallMs?: number;
  /** Progress sink (throttled to ~2 Hz; final tick is forced). */
  onProgress?: (progress: AgentdUpdateProgress) => void;
  /** Log sink so the caller's write() captures download lines. */
  onLog?: (line: string) => void;
}

async function loadTarball(
  source: string,
  opts: LoadTarballOpts = {},
): Promise<{ path: string; cleanup: () => void }> {
  if (/^https?:\/\//i.test(source)) {
    const fetchFn = opts.fetchFn ?? fetch;
    const say = opts.onLog ?? log;
    const stallMs = opts.stallMs ?? DEFAULT_DOWNLOAD_STALL_MS;
    say(`Downloading ${source} …`);
    // Streamed download: byte-level progress + a stall watchdog. The old
    // single-shot arrayBuffer() fetch reported nothing between "Downloading"
    // and "Downloaded" — minutes of silence on a slow link, and a hung
    // transfer with no timeout at all. The watchdog aborts when no bytes
    // arrive for stallMs (headers included: lastByteAt starts at t0).
    const controller = new AbortController();
    const startedAt = Date.now();
    let lastByteAt = startedAt;
    let received = 0;
    let stalled = false;
    // Cadence: ~4 checks per stall window, clamped to [250ms, 1s]. Ref'd on
    // purpose — the watchdog must fire even when nothing else holds the
    // loop (a hung connect parks the worker otherwise).
    const tickMs = Math.max(250, Math.min(1000, Math.floor(stallMs / 4)));
    const stallTimer = setInterval(() => {
      if (Date.now() - lastByteAt >= stallMs) {
        stalled = true;
        controller.abort();
      }
    }, tickMs);
    let totalBytes: number | undefined;
    let response: Response;
    try {
      response = await fetchFn(source, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) {
        throw new Error(`download failed: HTTP ${response.status}`);
      }
      const declared = Number(response.headers?.get?.("content-length") ?? "");
      if (Number.isFinite(declared) && declared > 0) totalBytes = declared;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("download failed: response has no body");
      const chunks: Buffer[] = [];
      let lastEmit = 0;
      const emit = (force = false): void => {
        const nowMs = Date.now();
        if (!force && nowMs - lastEmit < 500) return;
        lastEmit = nowMs;
        const elapsed = Math.max(1, nowMs - startedAt);
        const pct =
          totalBytes !== undefined && received <= totalBytes
            ? Math.min(100, Math.floor((received / totalBytes) * 100))
            : undefined;
        opts.onProgress?.({
          receivedBytes: received,
          ...(totalBytes !== undefined ? { totalBytes } : {}),
          ...(elapsed > 250 ? { bytesPerSec: Math.round((received / elapsed) * 1000) } : {}),
          ...(pct !== undefined ? { pct } : {}),
        });
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          lastByteAt = Date.now();
          received += value.byteLength;
          chunks.push(Buffer.from(value));
          emit();
        }
      }
      emit(true);
      const bytes = Buffer.concat(chunks);
      const dir = mkdtempSync(join(tmpdir(), "agentd-update-"));
      const file = join(dir, "release.tar.gz");
      writeFileSync(file, bytes);
      say(`Downloaded ${fmtMb(bytes.byteLength)}${totalBytes !== undefined ? ` of ${fmtMb(totalBytes)}` : ""}`);
      return {
        path: file,
        cleanup: () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        },
      };
    } catch (error) {
      if (stalled) {
        throw new Error(
          `download stalled — no bytes for ${Math.max(1, Math.round(stallMs / 1000))}s (${fmtMb(received)}${totalBytes !== undefined ? ` / ${fmtMb(totalBytes)}` : ""})`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearInterval(stallTimer);
    }
  }
  if (!existsSync(source)) {
    throw new Error(`file not found: ${source}`);
  }
  return { path: source, cleanup: () => {} };
}

export interface AgentdUpdateInput {
  source: string;
  sha256?: string;
  force?: boolean;
  installDir: string;
  /** Line sink for progress reporting (CLI = stdout; worker = status capture). */
  write?: (message: string) => void;
  /** Structured pipeline events (agentd ≥ 1.4 fine-grained console progress). */
  onStep?: (event: AgentdUpdateStepEvent) => void;
  /** Injectable fetch for tests (streaming download path). */
  fetchFn?: typeof fetch;
  /** Download stall watchdog override (tests). */
  downloadStallMs?: number;
}

export type AgentdUpdateOutcome =
  | { ok: true; version: string; previousTarget: string | null; restarted: boolean }
  | { ok: false; error: string };

function resolveLink(linkDir: string, target: string): string {
  return resolve(target.startsWith("/") ? target : join(linkDir, target));
}

/** Replace a symlink without a window where the path is absent. */
function atomicSymlink(target: string, linkPath: string): void {
  const tmp = `${linkPath}.next-${randomUUID().slice(0, 8)}`;
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, linkPath);
  } catch {
    rmSync(linkPath, { force: true });
    renameSync(tmp, linkPath);
  }
}

/**
 * Install a finished tree at targetDir. An existing directory is moved aside
 * only after the new tree is complete, and moved back if the final rename
 * fails — the live release is never deleted first.
 */
function commitReleaseTree(incoming: string, targetDir: string): void {
  if (!existsSync(targetDir)) {
    renameSync(incoming, targetDir);
    return;
  }
  const retired = join(dirname(targetDir), `.${basename(targetDir)}.retired`);
  rmSync(retired, { recursive: true, force: true });
  renameSync(targetDir, retired);
  try {
    renameSync(incoming, targetDir);
  } catch (error) {
    try {
      if (!existsSync(targetDir)) renameSync(retired, targetDir);
    } catch {
      /* leave the retired tree for manual recovery */
    }
    throw error;
  }
  rmSync(retired, { recursive: true, force: true });
}

/**
 * Shared update core: verify → extract → smoke → install → switch symlinks →
 * (root) refresh units + restart the service. Never throws — failures come
 * back as { ok: false, error } so the remote path can surface them in the
 * console instead of a stack trace.
 */
export async function performAgentdUpdate(input: AgentdUpdateInput): Promise<AgentdUpdateOutcome> {
  const write = input.write ?? ((message: string) => process.stdout.write(`${message}\n`));
  const onStep = input.onStep;
  const expectedSha = input.sha256?.trim().toLowerCase() ?? "";
  if (/^http:\/\//i.test(input.source)) {
    return { ok: false, error: "plain-http sources are not allowed (https only)" };
  }
  const isRemote = /^https:\/\//i.test(input.source);
  if (isRemote && !expectedSha) {
    return {
      ok: false,
      error: "refusing to install from a URL without a sha256 (pass the value from the release's .sha256 file)",
    };
  }

  let tarball: { path: string; cleanup: () => void };
  try {
    if (isRemote && onStep) {
      onStep({ step: "download", progress: { receivedBytes: 0 } });
    }
    tarball = await loadTarball(input.source, {
      fetchFn: input.fetchFn,
      stallMs: input.downloadStallMs,
      onLog: write,
      ...(onStep && isRemote
        ? { onProgress: (progress) => onStep({ step: "download", progress }) }
        : {}),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let staging: string | null = null;
  let incoming: string | null = null;
  try {
    // ── sha256 ────────────────────────────────────────────────
    onStep?.({ step: "verify" });
    const digest = createHash("sha256")
      .update(readFileSync(tarball.path))
      .digest("hex");
    if (expectedSha) {
      if (digest !== expectedSha) {
        return { ok: false, error: `sha256 mismatch\n  expected ${expectedSha}\n  actual   ${digest}` };
      }
      write(`✔ sha256 verified (${digest})`);
    } else {
      write(`sha256 ${digest} (local source — not verified)`);
    }

    // ── Extract ───────────────────────────────────────────────
    onStep?.({ step: "extract" });
    staging = mkdtempSync(join(tmpdir(), "agentd-stage-"));
    const extracted = spawnSync("tar", ["-xzf", tarball.path, "-C", staging]);
    if (extracted.error || extracted.status !== 0) {
      return {
        ok: false,
        error: `tar failed: ${extracted.error?.message ?? `exit ${extracted.status}`}`,
      };
    }

    const rootName = readdirSync(staging).find((name) =>
      existsSync(join(staging, name, "package.json")),
    );
    if (!rootName) {
      return { ok: false, error: "tarball does not contain a release root (missing package.json)" };
    }
    const releaseRoot = join(staging, rootName);
    let pkg: { name?: unknown; version?: unknown };
    try {
      pkg = JSON.parse(readFileSync(join(releaseRoot, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
    } catch (error) {
      return {
        ok: false,
        error: `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (pkg.name !== "jellybot-agentd" || typeof pkg.version !== "string" || !pkg.version.trim()) {
      return { ok: false, error: `unexpected package identity in tarball: ${JSON.stringify(pkg)}` };
    }
    const version = pkg.version.trim();
    const targetDir = join(input.installDir, version);

    // ── Pre-switch smoke (also validates the release layout) ──
    onStep?.({ step: "smoke" });
    const smokeError = smokeRelease(releaseRoot, version);
    if (smokeError) {
      return { ok: false, error: `smoke check failed: ${smokeError}` };
    }

    if (existsSync(targetDir) && !input.force) {
      return {
        ok: false,
        error: `${targetDir} already exists — bump the version or force a reinstall`,
      };
    }

    // ── Stage beside the live tree, then swap ─────────────────
    onStep?.({ step: "install" });
    const currentPath = join(input.installDir, "current");
    const previousPath = join(input.installDir, "previous");
    let oldTarget: string | null = null;
    try {
      oldTarget = readlinkSync(currentPath);
    } catch {
      oldTarget = null;
    }
    const replacingLive =
      oldTarget !== null && resolveLink(input.installDir, oldTarget) === resolve(targetDir);
    let previousKept: string | null = null;
    try {
      previousKept = readlinkSync(previousPath);
    } catch {
      previousKept = null;
    }

    incoming = join(input.installDir, `.${version}.incoming`);
    rmSync(incoming, { recursive: true, force: true });
    mkdirSync(input.installDir, { recursive: true });
    cpSync(releaseRoot, incoming, { recursive: true });
    chmodSync(join(incoming, "bin", "agentd"), 0o755);
    commitReleaseTree(incoming, targetDir);
    incoming = null;

    // Same-version reinstall keeps the real rollback target. A new version
    // records the release `current` was pointing at.
    onStep?.({ step: "switch" });
    if (!replacingLive && oldTarget) {
      atomicSymlink(oldTarget, previousPath);
      previousKept = oldTarget;
    }
    atomicSymlink(targetDir, currentPath);
    write(`✔ installed ${version} — current → ${targetDir}`);
    if (replacingLive) {
      write(
        previousKept
          ? `  previous unchanged → ${previousKept}`
          : `  previous unchanged (none)`,
      );
    } else if (oldTarget) {
      write(`  previous → ${oldTarget} (agentd rollback returns here)`);
    }

    // ── Units + restart ───────────────────────────────────────
    onStep?.({ step: "units" });
    syncSystemdUnits(targetDir, write);
    onStep?.({ step: "restart" });
    let restarted = false;
    if (process.getuid?.() === 0) {
      restarted = restartService();
      write(
        restarted
          ? `✔ restarted ${SERVICE_NAME}`
          : `⚠ restart failed or unavailable — run: sudo systemctl restart ${SERVICE_NAME}`,
      );
    } else {
      write(`Service restart: run \`sudo systemctl restart ${SERVICE_NAME}\` (or let the supervisor handle it)`);
    }
    write(`Bundled version: ${resolveAgentdVersion() === version ? version : `${version} (running CLI reports another version)`}`);
    return { ok: true, version, previousTarget: previousKept, restarted };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    tarball.cleanup();
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (incoming) {
      try {
        rmSync(incoming, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export async function runAgentdUpdate(args: string[]): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const source = positional[0];
  if (!source) {
    return fail(
      "usage: agentd update <url-or-path> [--sha256 <hex>] [--install-dir <dir>] [--force]",
    );
  }
  const installDir = resolveInstallDir(flags);

  const outcome = await performAgentdUpdate({
    source,
    sha256: typeof flags.sha256 === "string" ? flags.sha256 : undefined,
    force: flags.force === true,
    installDir,
  });
  if (!outcome.ok) return fail(outcome.error);

  log(`Verify:  journalctl -u ${SERVICE_NAME} -n 30 --no-pager`);
  return 0;
}

export async function runAgentdRollback(): Promise<number> {
  const installDir = resolveInstallDir({});
  const currentPath = join(installDir, "current");
  const previousPath = join(installDir, "previous");

  let currentTarget: string | null = null;
  let previousTarget: string | null = null;
  try {
    currentTarget = readlinkSync(currentPath);
  } catch {
    currentTarget = null;
  }
  try {
    previousTarget = readlinkSync(previousPath);
  } catch {
    previousTarget = null;
  }
  if (!currentTarget) return fail(`no ${currentPath} symlink — nothing to roll back`);
  if (!previousTarget || !statSync(previousTarget, { throwIfNoEntry: false })) {
    return fail(`no usable previous release (${previousPath})`);
  }

  rmSync(currentPath, { force: true });
  symlinkSync(previousTarget, currentPath);
  rmSync(previousPath, { force: true });
  symlinkSync(currentTarget, previousPath);
  log(`✔ rolled back — current → ${previousTarget}`);

  if (process.getuid?.() === 0) {
    log(
      restartService()
        ? `✔ restarted ${SERVICE_NAME}`
        : `⚠ restart failed or unavailable — run: sudo systemctl restart ${SERVICE_NAME}`,
    );
  } else {
    log(`Now restart the service:  sudo systemctl restart ${SERVICE_NAME}`);
  }
  return 0;
}
