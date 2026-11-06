/**
 * Stop a debuggee without leaving Electron / electron-vite grandchildren.
 *
 * Windows `child.kill()` on `electron-vite.cmd` (often wrapped in cmd.exe)
 * only ends the shell; Chromium stays up. Always `taskkill /T` first.
 * POSIX needs a dedicated process group (`detached: true` at spawn).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

function validPid(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseNetstatListeningEntries(
  output: string,
): Array<{ port: number; pid: number }> {
  const entries: Array<{ port: number; pid: number }> = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !/LISTEN/i.test(line)) continue;
    const match = line.match(/^TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!match) continue;
    const local = match[1]!;
    const pid = Number(match[2]);
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const localPort = Number(local.slice(colon + 1).replace(/\]$/, ""));
    if (localPort > 0 && localPort < 65536 && validPid(pid)) {
      entries.push({ port: localPort, pid });
    }
  }
  return entries;
}

export function parseNetstatListeningPids(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const entry of parseNetstatListeningEntries(output)) {
    if (entry.port === port) pids.add(entry.pid);
  }
  return [...pids];
}

export function pidsListeningOnPort(port: number | undefined): number[] {
  if (!validPid(port)) return [];
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      });
      return parseNetstatListeningPids(out, port).filter(
        (pid) => pid !== process.pid,
      );
    }
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 5_000 },
    );
    return out
      .split(/\s+/)
      .map((token) => Number(token))
      .filter((pid) => validPid(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

export function uniquePids(pids: Array<number | undefined>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const pid of pids) {
    if (!validPid(pid) || pid === process.pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

function killPidTreeWindows(pid: number): Promise<void> {
  if (!validPid(pid)) return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish();
    }, 8_000);
    child.once("error", finish);
    child.once("exit", finish);
  });
}

function signalPidTreePosix(pid: number, signal: NodeJS.Signals): void {
  if (!validPid(pid)) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* not a group leader — fall through */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(hasExited());
    }, timeoutMs);
    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const hasExited = (): boolean =>
      child.exitCode !== null || child.signalCode !== null;
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

/**
 * Terminate a process this debug session launched (Unreal Editor, Electron, or web)
 * including Windows grandchildren (electron.exe under electron-vite.cmd).
 */
export async function terminateLaunchedProcess(
  debuggee: ChildProcess | undefined,
  extraPids: number[] = [],
): Promise<void> {
  const pids = uniquePids([debuggee?.pid, ...extraPids]);
  if (pids.length === 0) return;

  if (process.platform === "win32") {
    // Do not `child.kill()` first — that orphans cmd.exe children before
    // taskkill /T can see them.
    for (const pid of pids) {
      await killPidTreeWindows(pid);
    }
    if (debuggee?.pid) await waitForChildExit(debuggee, 2_000);
    return;
  }

  for (const pid of pids) signalPidTreePosix(pid, "SIGTERM");
  try {
    debuggee?.kill("SIGTERM");
  } catch {
    /* gone */
  }
  if (debuggee?.pid) await waitForChildExit(debuggee, 750);
  for (const pid of pids) {
    if (isAlive(pid)) signalPidTreePosix(pid, "SIGKILL");
  }
  try {
    debuggee?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  if (debuggee?.pid) await waitForChildExit(debuggee, 1_000);
}
