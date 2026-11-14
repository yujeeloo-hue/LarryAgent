import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shell } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import { createLegacyRetirement, isMissingLaunchctlService } from "./legacyRetirement.js";

const execFileAsync = promisify(execFile);

/** launchd service label for the Loops daemon (LaunchAgent, per-user). */
export const LOOPS_DAEMON_LABEL = "com.jellybot.app.loops";

export function loopsPlistPath(): string {
  return join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${LOOPS_DAEMON_LABEL}.plist`,
  );
}

/**
 * Resolve the daemon entry bundle.
 * Packaged: extraResources → Contents/Resources/daemon/loops-daemon.mjs
 * Dev/preview: electron-vite output under out/daemon/.
 */
export function daemonBundlePath(): string {
  const candidates = [
    ...(typeof process.resourcesPath === "string" && process.resourcesPath
      ? [join(process.resourcesPath, "daemon", "loops-daemon.mjs")]
      : []),
    join(process.cwd(), "out", "daemon", "loops-daemon.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), "out", "daemon", "loops-daemon.mjs");
}

export type LoopsDaemonStatus = {
  availability: "loaded" | "absent" | "unknown";
  /** launchd service loaded in the user's gui domain. */
  loaded: boolean;
  /** Parsed first top-level state from `launchctl print` (e.g. running). */
  state: string | null;
  pid: number | null;
  /** plist exists on disk under ~/Library/LaunchAgents. */
  plistExists: boolean;
  /** plist exists but points at a different binary than this app instance. */
  plistStale: boolean;
  lastError: string | null;
};

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Render the LaunchAgent plist (RunAtLoad + crash-only KeepAlive, JTC-style). */
export function renderLoopsPlist(input: {
  execPath: string;
  scriptPath: string;
  appDataRoot: string;
  logDir: string;
  resourcesDir?: string | null;
  appVersion?: string | null;
}): string {
  const label = xmlEscape(LOOPS_DAEMON_LABEL);
  const execPath = xmlEscape(input.execPath);
  const scriptPath = xmlEscape(input.scriptPath);
  const appDataRoot = xmlEscape(input.appDataRoot);
  const outLog = xmlEscape(join(input.logDir, "loops-daemon.out.log"));
  const errLog = xmlEscape(join(input.logDir, "loops-daemon.err.log"));
  const resourcesEntry = input.resourcesDir
    ? `    <key>JELLYBOT_RESOURCES_DIR</key>\n    <string>${xmlEscape(input.resourcesDir)}</string>\n`
    : "";
  const versionEntry = input.appVersion
    ? `    <key>JELLYBOT_APP_VERSION</key>\n    <string>${xmlEscape(input.appVersion)}</string>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>JELLYBOT_APP_DATA</key>
    <string>${appDataRoot}</string>
${resourcesEntry}${versionEntry}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
</dict>
</plist>
`;
}

/** Extract a top-level `key = value` pair from launchctl print output. */
function parseLaunchctlField(output: string, key: string): string | null {
  const match = output.match(new RegExp(`^\\t${key} = (.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

async function launchctl(
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string; absent: boolean }> {
  try {
    const { stdout } = await execFileAsync("/bin/launchctl", args, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return { ok: true, stdout };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = error as { code?: string | number; stderr?: string; killed?: boolean; signal?: string | null };
    return { ok: false, error: message, absent: args[0] === "print" && isMissingLaunchctlService(failure) };
  }
}

function guiTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("process.getuid unavailable on this platform");
  }
  return `gui/${uid}`;
}

/** Read-only probe of daemon install + runtime state. Never throws. */
export async function getLoopsDaemonStatus(): Promise<LoopsDaemonStatus> {
  const plistPath = loopsPlistPath();
  const plistExists = existsSync(plistPath);
  let plistStale = false;
  if (plistExists) {
    try {
      const content = readFileSync(plistPath, "utf-8");
      // First <string> inside ProgramArguments is the binary path.
      const argsMatch = content.match(
        /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
      );
      if (argsMatch?.[1]) {
        plistStale = argsMatch[1] !== process.execPath;
      }
    } catch {
      // Unreadable plist → treat as stale so repair reinstalls it.
      plistStale = true;
    }
  }

  const printed = await launchctl([
    "print",
    `${guiTarget()}/${LOOPS_DAEMON_LABEL}`,
  ]);
  if (!printed.ok) {
    return {
      availability: printed.absent ? "absent" : "unknown",
      loaded: false,
      state: null,
      pid: null,
      plistExists,
      plistStale,
      lastError: printed.error,
    };
  }
  const state = parseLaunchctlField(printed.stdout, "state");
  const pidText = parseLaunchctlField(printed.stdout, "pid");
  const pid = pidText ? Number(pidText) : null;
  return {
    availability: "loaded",
    loaded: true,
    state,
    pid: pid !== null && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    plistExists,
    plistStale,
    lastError: null,
  };
}

/** Retained compatibility entry point: independent scheduling cannot be reinstalled. */
export async function installLoopsDaemon(): Promise<LoopsDaemonStatus> {
  throw new Error("Independent Loops scheduling has been retired. Coco runs only while the application is open.");
}

/**
 * Deliberate stop: bootout the service but keep the plist on disk. KeepAlive
 * lives on the bootstrapped service, so nothing respawns the daemon until a
 * later bootstrap starts it again. The caller persists a stopped-by-user
 * marker so auto paths (screen-entry ensure, startup repair) do not
 * resurrect it against the user's intent.
 */
export async function stopLoopsDaemon(): Promise<LoopsDaemonStatus> {
  const stopped = await launchctl([
    "bootout",
    `${guiTarget()}/${LOOPS_DAEMON_LABEL}`,
  ]);
  const status = await getLoopsDaemonStatus();
  // Booting out an already-unloaded service errors — fine if it ended up
  // stopped anyway; only surface a failure that left it loaded.
  if (stopped.ok || !status.loaded) return status;
  return { ...status, lastError: stopped.error };
}

/**
 * Uninstall: bootout the service and move the plist to Trash (never rm).
 */
export async function uninstallLoopsDaemon(): Promise<{
  ok: boolean;
  message?: string;
}> {
  await launchctl(["bootout", `${guiTarget()}/${LOOPS_DAEMON_LABEL}`]);
  const plistPath = loopsPlistPath();
  if (existsSync(plistPath)) {
    try {
      await shell.trashItem(plistPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `bootout ok; plist trash failed: ${message}` };
    }
  }
  return { ok: true };
}

/**
 * App-side health check at startup: repair only when a plist exists but is
 * stale (different binary) or unloaded. Never installs fresh — the user may
 * have intentionally uninstalled; first-use install happens on the Loops screen.
 */
export async function repairLoopsDaemonIfStale(): Promise<LoopsDaemonStatus> {
  const status = await getLoopsDaemonStatus();
  if (!status.plistExists) return status;
  if (!status.plistStale && status.loaded) return status;
  return installLoopsDaemon();
}

/**
 * First-use install: create the LaunchAgent when missing/stale (Loops screen).
 */
export async function ensureLoopsDaemonInstalled(): Promise<LoopsDaemonStatus> {
  const status = await getLoopsDaemonStatus();
  if (status.plistExists && !status.plistStale && status.loaded) {
    return status;
  }
  return installLoopsDaemon();
}

/** Migration barrier: never admit Coco work while the old executor may be alive. */
const retireLegacy = createLegacyRetirement({
  status: getLoopsDaemonStatus,
  uninstall: uninstallLoopsDaemon,
  processAlive: pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  },
  now: Date.now,
  sleep: async (ms, signal) => { await delay(ms, undefined, signal ? { signal } : {}); },
});
export async function retireLoopsDaemon(signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
  if (process.platform !== "darwin") return { ok: true };
  return retireLegacy(signal);
}
