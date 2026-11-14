/**
 * Read-only inspection of the compile command clangd uses for one file —
 * feeds the `clangd.compile_flags` diagnostic log line.
 *
 * UBT's GenerateClangDatabase writes `clang-cl.exe @"<file>.obj.rsp"` and
 * that response file pulls in a shared `@"<Module>.Shared.rsp"` holding
 * ~1000 `/I` include directories, so the interesting numbers only appear
 * after expanding response files recursively.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type CompileFlagsSummary = {
  /** Total arguments after response-file expansion. */
  argCount: number;
  /** `/I`, `-I`, `/external:I`, `-imsvc`, `-isystem` directories. */
  includeDirs: number;
  /** `/D` / `-D` macro definitions. */
  defines: number;
  /** Forced includes (`/FI`, `-include`), basename only. */
  forcedIncludes: string[];
  /** PCH-related flags (`/Yu`, `/Yc`, `/Fp`, `-include-pch`). */
  pchFlags: string[];
  /** Response files expanded (nested). */
  responseFiles: number;
};

/** Split a command line the way clang does for response files (quotes, no escapes). */
export function tokenizeCommandLine(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  let has = false;
  for (const ch of text) {
    if (ch === '"') {
      inQuote = !inQuote;
      has = true;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (has) out.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has) out.push(current);
  return out;
}

function baseName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

/** Summarize an already-expanded argument list. */
export function summarizeArgs(args: readonly string[], responseFiles = 0): CompileFlagsSummary {
  let includeDirs = 0;
  let defines = 0;
  const forcedIncludes: string[] = [];
  const pchFlags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    const takesValue = (flag: string) => arg === flag && next !== undefined;
    if (/^(?:[/-]I|[/-]external:I|-imsvc|-isystem)(.*)$/.test(arg)) {
      includeDirs += 1;
      if (/^(?:[/-]I|[/-]external:I|-imsvc|-isystem)$/.test(arg)) i += 1;
      continue;
    }
    if (/^[/-]D/.test(arg)) {
      defines += 1;
      if (arg === "/D" || arg === "-D") i += 1;
      continue;
    }
    if (takesValue("/FI") || takesValue("-include")) {
      forcedIncludes.push(baseName(next!));
      i += 1;
      continue;
    }
    const inlineFi = /^(?:\/FI|-include)(.+)$/.exec(arg);
    if (inlineFi && !arg.startsWith("-include-pch")) {
      forcedIncludes.push(baseName(inlineFi[1]!));
      continue;
    }
    if (/^(?:\/Yu|\/Yc|\/Fp|-include-pch)/.test(arg)) pchFlags.push(arg.length > 80 ? `${arg.slice(0, 80)}…` : arg);
  }
  return { argCount: args.length, includeDirs, defines, forcedIncludes, pchFlags, responseFiles };
}

/** Expand `@file` arguments recursively (relative to `directory`). */
export async function expandResponseFiles(
  args: readonly string[],
  directory: string,
  depth = 0,
): Promise<{ args: string[]; responseFiles: number }> {
  const out: string[] = [];
  let responseFiles = 0;
  for (const arg of args) {
    if (!arg.startsWith("@") || depth > 4) {
      out.push(arg);
      continue;
    }
    const ref = arg.slice(1);
    const path = isAbsolute(ref) ? ref : join(directory, ref);
    try {
      const nested = tokenizeCommandLine(await readFile(path, "utf8"));
      const expanded = await expandResponseFiles(nested, directory, depth + 1);
      out.push(...expanded.args);
      responseFiles += 1 + expanded.responseFiles;
    } catch {
      out.push(arg); // unreadable — keep the reference, count nothing
    }
  }
  return { args: out, responseFiles };
}

type DbEntry = { command?: string; arguments?: string[]; directory: string };

function normKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Lazily loaded `compile_commands.json` keyed by file (lower-cased, `/`).
 * Reloaded when the database mtime changes (UBT regeneration).
 */
export class CompileDbInspector {
  private loaded: { path: string; mtimeMs: number; entries: Map<string, DbEntry> } | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly compileCommandsDir: string) {}

  private async ensure(): Promise<Map<string, DbEntry> | null> {
    const dbPath = join(this.compileCommandsDir, "compile_commands.json");
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(dbPath)).mtimeMs;
    } catch {
      return null;
    }
    if (this.loaded && this.loaded.path === dbPath && this.loaded.mtimeMs === mtimeMs) {
      return this.loaded.entries;
    }
    if (!this.loading) {
      this.loading = (async () => {
        const raw = JSON.parse(await readFile(dbPath, "utf8")) as unknown;
        const entries = new Map<string, DbEntry>();
        if (Array.isArray(raw)) {
          for (const item of raw as Record<string, unknown>[]) {
            if (typeof item?.file !== "string" || typeof item.directory !== "string") continue;
            entries.set(normKey(item.file), {
              directory: item.directory,
              ...(typeof item.command === "string" ? { command: item.command } : {}),
              ...(Array.isArray(item.arguments) ? { arguments: item.arguments as string[] } : {}),
            });
          }
        }
        this.loaded = { path: dbPath, mtimeMs, entries };
      })().finally(() => {
        this.loading = null;
      });
    }
    try {
      await this.loading;
    } catch {
      return null;
    }
    return this.loaded?.entries ?? null;
  }

  /** Lower-cased basenames of every translation unit in the database. */
  async sourceBasenames(): Promise<Set<string>> {
    const entries = await this.ensure();
    const out = new Set<string>();
    for (const key of entries?.keys() ?? []) out.add(key.slice(key.lastIndexOf("/") + 1));
    return out;
  }

  /** Summary for `file`, or null when the database has no entry for it. */
  async inspect(file: string): Promise<CompileFlagsSummary | null> {
    const entries = await this.ensure();
    const entry = entries?.get(normKey(file));
    if (!entry) return null;
    const args = entry.arguments ?? tokenizeCommandLine(entry.command ?? "");
    const expanded = await expandResponseFiles(args, entry.directory);
    return summarizeArgs(expanded.args, expanded.responseFiles);
  }
}
