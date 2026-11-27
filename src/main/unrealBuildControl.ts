import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { killPidTree } from "../debug/killProcessTree.js";
import {
  parseProcessList,
  ubtResult,
  type TrackedBuildProcess,
} from "../unreal/buildOwnership.js";

const execFileAsync = promisify(execFile);
const POLL_MS = 500;
const PUMP_BYTES = 1024 * 1024;
const TAIL_BYTES = 64 * 1024;

const LIST_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$items = @(Get-CimInstance Win32_Process -Filter "Name='dotnet.exe' OR Name='cmd.exe' OR Name='MSBuild.exe'" | Select-Object ProcessId,ParentProcessId,Name,CommandLine)
if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress -Depth 3 }
`;

let processSource: (() => Promise<TrackedBuildProcess[]>) | null = null;

export function setUnrealBuildProcessSourceForTests(
  source: (() => Promise<TrackedBuildProcess[]>) | null,
): void {
  processSource = source;
}

export function unrealBuildToolLogPath(engineRoot: string): string {
  return join(engineRoot, "Programs", "UnrealBuildTool", "Log.txt");
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function inTestRunner(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes("--test");
}

function decodeProcessOutput(stdout: string | Buffer): string {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le").replace(/^\uFEFF/, "");
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return buf.toString("utf16le").replace(/^\uFEFF/, "");
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

export async function listUnrealBuildProcesses(): Promise<TrackedBuildProcess[]> {
  if (processSource) return processSource();
  if (inTestRunner() || process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      LIST_SCRIPT,
    ], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const text = decodeProcessOutput(stdout).trim();
    if (!text) return [];
    return parseProcessList(JSON.parse(text) as unknown);
  } catch (error) {
    console.error("[devtasks] could not list Unreal build processes", error);
    return [];
  }
}

export async function forceKillPids(pids: readonly number[]): Promise<void> {
  const unique = [...new Set(pids)].filter((pid) => pid > 0 && pid !== process.pid);
  await Promise.all(unique.map((pid) => killPidTree(pid)));
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function readRange(
  path: string,
  offset: number,
  length: number,
): Promise<{ text: string; bytes: number } | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export async function readLogTail(path: string, maxBytes = TAIL_BYTES): Promise<string | null> {
  const size = await fileSize(path);
  if (size == null || size === 0) return null;
  const offset = Math.max(0, size - maxBytes);
  return (await readRange(path, offset, size - offset))?.text ?? null;
}

async function readAppended(path: string, offset: number): Promise<{ text: string; size: number } | null> {
  const size = await fileSize(path);
  if (size == null) return null;
  if (size < offset) return { text: "", size: 0 };
  if (size === offset) return { text: "", size: offset };
  let cursor = offset;
  if (cursor === 0 && size > PUMP_BYTES) cursor = size - PUMP_BYTES;
  const length = Math.min(size - cursor, PUMP_BYTES);
  const read = await readRange(path, cursor, length);
  if (!read) return null;
  return { text: read.text, size: cursor + read.bytes };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export type ExternalBuildEnd = "succeeded" | "failed" | "cancelled" | "timeout" | "lost";

export async function followExternalBuild(input: {
  pid: number;
  logPath: string | null;
  signal: AbortSignal;
  timeoutAt: number | null;
  onLog: (text: string) => void;
}): Promise<ExternalBuildEnd> {
  let offset = input.logPath ? (await fileSize(input.logPath)) ?? 0 : 0;
  while (true) {
    if (input.signal.aborted) return "cancelled";
    if (input.timeoutAt != null && Date.now() >= input.timeoutAt) return "timeout";
    if (input.logPath) {
      const appended = await readAppended(input.logPath, offset);
      if (appended && appended.size < offset) offset = 0;
      if (appended && appended.text) {
        offset = appended.size;
        input.onLog(appended.text);
      } else if (appended) {
        offset = appended.size;
      }
    }
    if (!pidAlive(input.pid)) {
      if (input.logPath) {
        const rest = await readAppended(input.logPath, offset);
        if (rest?.text) input.onLog(rest.text);
      }
      const tail = input.logPath ? await readLogTail(input.logPath) : null;
      const result = tail ? ubtResult(tail) : null;
      if (result === "succeeded") return "succeeded";
      if (result === "failed") return "failed";
      return "lost";
    }
    await delay(POLL_MS, input.signal);
  }
}
