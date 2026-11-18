
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { includeDirsFromArgs } from "../../shared/cppIncludes.js";

export type CompileFlagsSummary = {
  argCount: number;
  includeDirs: number;
  defines: number;
  forcedIncludes: string[];
  pchFlags: string[];
  responseFiles: number;
};

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
      out.push(arg);
    }
  }
  return { args: out, responseFiles };
}

type DbEntry = { command?: string; arguments?: string[]; directory: string };

function normKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export class CompileDbInspector {
  private loaded: { path: string; mtimeMs: number; entries: Map<string, DbEntry> } | null = null;
  private loading: Promise<void> | null = null;
  private byDirectory: Map<string, DbEntry> | null = null;
  private readonly includeDirsByFile = new Map<string, Promise<string[]>>();

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
        this.byDirectory = null;
        this.includeDirsByFile.clear();
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

  async sourceBasenames(): Promise<Set<string>> {
    const entries = await this.ensure();
    const out = new Set<string>();
    for (const key of entries?.keys() ?? []) out.add(key.slice(key.lastIndexOf("/") + 1));
    return out;
  }

  async inspect(file: string): Promise<CompileFlagsSummary | null> {
    const entries = await this.ensure();
    const entry = entries?.get(normKey(file));
    if (!entry) return null;
    const args = entry.arguments ?? tokenizeCommandLine(entry.command ?? "");
    const expanded = await expandResponseFiles(args, entry.directory);
    return summarizeArgs(expanded.args, expanded.responseFiles);
  }

  private directoryIndex(entries: Map<string, DbEntry>): Map<string, DbEntry> {
    if (this.byDirectory) return this.byDirectory;
    const index = new Map<string, DbEntry>();
    for (const [key, entry] of entries) {
      const dir = key.slice(0, key.lastIndexOf("/"));
      if (!index.has(dir)) index.set(dir, entry);
    }
    this.byDirectory = index;
    return index;
  }

  private entryFor(entries: Map<string, DbEntry>, file: string): DbEntry | null {
    const key = normKey(file);
    const exact = entries.get(key);
    if (exact) return exact;
    const index = this.directoryIndex(entries);
    const fileDir = key.slice(0, key.lastIndexOf("/"));
    let dir = fileDir;
    for (let depth = 0; depth < 8 && dir; depth++) {
      const hit = index.get(dir);
      if (hit) return hit;
      const cut = dir.lastIndexOf("/");
      if (cut <= 0) break;
      dir = dir.slice(0, cut);
    }
    return this.nearestDirectoryEntry(index, fileDir);
  }

  private nearestDirectoryEntry(index: Map<string, DbEntry>, dir: string): DbEntry | null {
    const parts = dir.toLowerCase().split("/");
    let bestEntry: DbEntry | null = null;
    let bestScore = 1;
    for (const [candidate, entry] of index) {
      const other = candidate.split("/");
      let score = 0;
      while (score < parts.length && score < other.length && parts[score] === other[score]) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }
    return bestEntry;
  }

  async includeDirs(file: string): Promise<string[]> {
    const key = normKey(file);
    const cached = this.includeDirsByFile.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const entries = await this.ensure();
      if (!entries) return [];
      const entry = this.entryFor(entries, file);
      if (!entry) return [];
      const args = entry.arguments ?? tokenizeCommandLine(entry.command ?? "");
      const expanded = await expandResponseFiles(args, entry.directory);
      return includeDirsFromArgs(expanded.args, entry.directory);
    })();
    this.includeDirsByFile.set(key, pending);
    const dirs = await pending.catch(() => [] as string[]);
    if (dirs.length === 0) this.includeDirsByFile.delete(key);
    return dirs;
  }
}
