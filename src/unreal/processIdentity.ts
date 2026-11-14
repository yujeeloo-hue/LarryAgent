import { execFile } from "node:child_process";
import { join } from "node:path";

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

export function matchesUnrealProcess(row: { ExecutablePath?: string; CommandLine?: string }, executable: string, project: string): boolean {
  if (normalizePath(row.ExecutablePath ?? "") !== normalizePath(executable) || !project) return false;
  const args = (row.CommandLine ?? "").match(/"[^"]*"|\S+/g) ?? [];
  return args.some(arg => normalizePath(arg.replace(/^"|"$/g, "")) === normalizePath(project));
}

/**
 * `ps` on Mac does not quote arguments, so a path that contains spaces
 * (`/Users/Shared/Epic Games/…`) cannot be split on whitespace. Match the
 * executable and the `.uproject` as bounded substrings of the whole command.
 */
export function commandMentionsPath(command: string, targetPath: string): boolean {
  const needle = normalizePath(targetPath).trim();
  if (!needle) return false;
  const haystack = normalizePath(command);
  const boundary = (char: string | undefined): boolean =>
    char === undefined || char === " " || char === '"' || char === "'";
  let from = 0;
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (boundary(at === 0 ? undefined : haystack[at - 1]) && boundary(haystack[at + needle.length])) return true;
    from = at + 1;
  }
  return false;
}

export async function findMatchingUnrealProcess(executable: string, project: string): Promise<number | null> {
  if (!project) return null;
  if (process.platform === "darwin") return findDarwinUnrealProcess(executable, project);
  if (process.platform !== "win32") return null;
  const script = "Get-CimInstance Win32_Process | Where-Object {$_.Name -like 'UnrealEditor*'} | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  return new Promise(resolve => {
    execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try {
        const data = JSON.parse(stdout);
        const rows = Array.isArray(data) ? data : [data];
        resolve(rows.find(row => row && matchesUnrealProcess(row, executable, project))?.ProcessId ?? null);
      } catch { resolve(null); }
    });
  });
}

function findDarwinUnrealProcess(executable: string, project: string): Promise<number | null> {
  return new Promise(resolve => {
    execFile("/bin/ps", ["-axww", "-o", "pid=,command="], { timeout: 5000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      for (const line of String(stdout).split("\n")) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match) continue;
        const command = match[2] ?? "";
        if (commandMentionsPath(command, executable) && commandMentionsPath(command, project)) {
          resolve(Number(match[1]));
          return;
        }
      }
      resolve(null);
    });
  });
}
