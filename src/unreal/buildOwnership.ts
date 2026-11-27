export type TrackedBuildProcess = {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
};

export type ProjectBuildPlan = {
  attach: TrackedBuildProcess | null;
  killPids: number[];
};

const UPROJECT_RE = /(?:^|[\s"'=])((?:[A-Za-z]:)?(?:\\|\/)[^\s"']*?\.uproject)/gi;
const ACTION_LINE_RE = /^\[(\d+)\/(\d+)\]/;

export function projectPathKey(input: string): string {
  const trimmed = input.trim().replace(/^["']+|["']+$/g, "").replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") {
      if (parts.length === 0 && part === "" && trimmed.startsWith("/")) parts.push("");
      continue;
    }
    if (part === "..") {
      const previous = parts[parts.length - 1];
      if (previous && previous !== ".." && !/^[A-Za-z]:$/.test(previous)) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/").toLowerCase();
}

export function commandReferencesProject(commandLine: string, uproject: string): boolean {
  const want = projectPathKey(uproject);
  if (!want.endsWith(".uproject")) return false;
  for (const match of commandLine.matchAll(UPROJECT_RE)) {
    const found = match[1];
    if (found && projectPathKey(found) === want) return true;
  }
  return false;
}

export function isUnrealCompilerCommand(commandLine: string): boolean {
  return /unrealbuildtool\.(?:dll|exe)/i.test(commandLine);
}

export function isUnrealBuildScript(commandLine: string): boolean {
  return /(?:^|[\s"'\\/])Build\.bat(?=$|[\s"'])/i.test(commandLine);
}

export function buildTargetLabel(commandLine: string): string | null {
  const match = /UnrealBuildTool\.(?:dll|exe)"?\s+([\s\S]+)$/i.exec(commandLine);
  if (!match?.[1]) return null;
  const parts: string[] = [];
  for (const token of match[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const text = token[1] ?? token[2] ?? token[3] ?? "";
    if (!text || text.startsWith("-")) break;
    parts.push(text);
    if (parts.length === 3) break;
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function compilerRank(commandLine: string): number {
  if (!isUnrealCompilerCommand(commandLine)) return 0;
  if (/GenerateClangDatabase/i.test(commandLine)) return 1;
  if (/-FromMsBuild\b/i.test(commandLine)) return 3;
  return 2;
}

export function planProjectBuild(
  processes: readonly TrackedBuildProcess[],
  uproject: string,
): ProjectBuildPlan {
  const matched = processes.filter((proc) =>
    proc.pid > 0 &&
    commandReferencesProject(proc.commandLine, uproject) &&
    (isUnrealCompilerCommand(proc.commandLine) ||
      isUnrealBuildScript(proc.commandLine) ||
      /^msbuild\.exe$/i.test(proc.name)),
  );
  const kill = new Set(matched.map((proc) => proc.pid));
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  for (const proc of matched) {
    if (!isUnrealCompilerCommand(proc.commandLine)) continue;
    const parent = byPid.get(proc.parentPid);
    if (parent && parent.pid > 0 && /^(msbuild|dotnet)\.exe$/i.test(parent.name)) {
      kill.add(parent.pid);
    }
  }
  const compilers = matched
    .filter((proc) => isUnrealCompilerCommand(proc.commandLine))
    .sort((a, b) => compilerRank(b.commandLine) - compilerRank(a.commandLine) || a.pid - b.pid);
  return { attach: compilers[0] ?? null, killPids: [...kill] };
}

export function latestOpenAction(logText: string): string | null {
  let action: string | null = null;
  let closed = false;
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.trim();
    if (ACTION_LINE_RE.test(line)) {
      action = line;
      closed = false;
    } else if (/^Result:\s*(?:Succeeded|Failed)\b/i.test(line)) {
      closed = true;
    }
  }
  return closed ? null : action;
}

export function ubtResult(logText: string): "succeeded" | "failed" | null {
  let result: "succeeded" | "failed" | null = null;
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.trim();
    if (ACTION_LINE_RE.test(line)) result = null;
    else if (/^Result:\s*Succeeded\b/i.test(line)) result = "succeeded";
    else if (/^Result:\s*Failed\b/i.test(line)) result = "failed";
  }
  return result;
}

function asNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseProcessList(payload: unknown): TrackedBuildProcess[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? [payload]
      : [];
  const out: TrackedBuildProcess[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const pid = asNumber(record.ProcessId ?? record.pid);
    const name = asString(record.Name ?? record.name);
    if (!pid || !name) continue;
    out.push({
      pid,
      parentPid: asNumber(record.ParentProcessId ?? record.parentPid) ?? 0,
      name,
      commandLine: asString(record.CommandLine ?? record.commandLine),
    });
  }
  return out;
}
