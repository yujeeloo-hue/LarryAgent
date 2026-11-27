import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  isUnrealProjectRoot,
  resolveUeEngineSourceRoot,
} from "../unreal/engineRoot.js";
import {
  SCAN_RANK_ASSET,
  TEMP_FILE_SUFFIX,
  UNREAL_ENGINE_TOP_DIRS,
  isAssetPath,
  isIgnoredFileName,
  isSkippedDir,
  isSkippedRelPath,
  type ScanRules,
} from "../workspaceScan/policy.js";
import { scanWorkspaceFiles, type ScanOptions } from "../workspaceScan/scanFiles.js";

export { resolveUeEngineSourceRoot };

const BROWSE_RULES: ScanRules = { mode: "walk", unreal: false };
export const EDITOR_FILE_MAX_BYTES = 4_000_000;
const WATCH_DEBOUNCE_MS = 150;


export type DevModeDirEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  ext: string;
  executable?: boolean;
};

export type DevModeListResult =
  | { ok: true; entries: DevModeDirEntry[] }
  | { ok: false; message: string };

export const PROJECT_FILE_MAX_BYTES = 12_000_000;

export type ProjectFileContentResult =
  | { ok: true; content: string; sizeBytes: number }
  | { ok: false; message: string };

export async function readProjectFile(
  targetPath: unknown,
): Promise<ProjectFileContentResult> {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  const path = resolve(targetPath.trim());
  const ext = extname(path).toLowerCase();
  if (ext !== ".vcxproj" && ext !== ".csproj" && ext !== ".sln") {
    return { ok: false, message: "Not a project file" };
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, message: "Not a regular file" };
    if (info.size > PROJECT_FILE_MAX_BYTES) {
      return {
        ok: false,
        message: `Project file is too large (max ${Math.floor(PROJECT_FILE_MAX_BYTES / 1_000_000)} MB).`,
      };
    }
    const buf = await readFile(path);
    if (buf.includes(0)) {
      return { ok: false, message: "Binary file — cannot parse as a project." };
    }
    const body =
      buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
        ? buf.subarray(3)
        : buf;
    return {
      ok: true,
      content: new TextDecoder("utf-8").decode(body),
      sizeBytes: info.size,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function listDevModeDir(
  targetPath: unknown,
): Promise<DevModeListResult> {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  const dir = resolve(targetPath.trim());
  if (!isAbsolute(dir)) {
    return { ok: false, message: "Absolute path required" };
  }
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries: DevModeDirEntry[] = [];
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (isSkippedDir(d.name, BROWSE_RULES)) continue;
        entries.push({
          name: d.name,
          path: join(dir, d.name),
          kind: "dir",
          ext: "",
        });
      } else if (d.isFile()) {
        if (isIgnoredFileName(d.name)) continue;
        const ext = extname(d.name).slice(1).toLowerCase();
        entries.push({
          name: d.name,
          path: join(dir, d.name),
          kind: "file",
          ext,
          ...(process.platform === "win32" && WINDOWS_EXECUTABLE_EXTS.has(ext)
            ? { executable: true }
            : {}),
        });
      }
    }
    if (process.platform !== "win32") {
      await Promise.all(
        entries
          .filter((e) => e.kind === "file")
          .map(async (e) => {
            if (
              process.platform === "darwin" &&
              POSIX_OPENABLE_EXTS.has(e.ext)
            ) {
              e.executable = true;
              return;
            }
            try {
              if ((await stat(e.path)).mode & 0o111) e.executable = true;
            } catch {
            }
          }),
      );
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}


export const WINDOWS_EXECUTABLE_EXTS = new Set([
  "exe", "bat", "cmd", "com", "lnk", "msi",
]);

const POSIX_TERMINAL_EXTS = new Set(["command", "terminal"]);

const POSIX_OPENABLE_EXTS = new Set(["dmg", "pkg"]);

export type ExecutableLaunchPlan =
  | { kind: "open-path" }
  | { kind: "spawn" }
  | { kind: "reject"; reason: string };

export function planExecutableLaunch(input: {
  platform: NodeJS.Platform;
  ext: string;
  executableBit: boolean;
}): ExecutableLaunchPlan {
  const ext = input.ext.toLowerCase();
  if (input.platform === "win32") {
    return WINDOWS_EXECUTABLE_EXTS.has(ext)
      ? { kind: "open-path" }
      : {
          kind: "reject",
          reason: "not a recognized Windows executable (.exe/.bat/.cmd/.lnk/.msi)",
        };
  }
  if (input.platform === "darwin" && POSIX_OPENABLE_EXTS.has(ext)) {
    return { kind: "open-path" };
  }
  if (!input.executableBit) {
    return { kind: "reject", reason: "file is not executable (chmod +x to run it)" };
  }
  return POSIX_TERMINAL_EXTS.has(ext)
    ? { kind: "open-path" }
    : { kind: "spawn" };
}


export type EditorFileResult =
  | {
      ok: true;
      content: string;
      encoding: "utf8" | "utf8-bom" | "non-utf8";
      sizeBytes: number;
      mtimeMs: number;
    }
  | { ok: false; message: string };

export async function readFileForEditor(
  targetPath: unknown,
): Promise<EditorFileResult> {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  const path = resolve(targetPath.trim());
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, message: "Not a regular file" };
    if (info.size > EDITOR_FILE_MAX_BYTES) {
      return {
        ok: false,
        message: `File is too large for the editor (max ${Math.floor(EDITOR_FILE_MAX_BYTES / 1000)} kB).`,
      };
    }
    const buf = await readFile(path);
    if (buf.includes(0)) {
      return { ok: false, message: "Binary file — cannot open in the editor." };
    }

    let body = buf;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      body = buf.subarray(3);
      return {
        ok: true,
        content: decodeChecked(body).content,
        encoding: "utf8-bom",
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
      };
    }
    const decoded = decodeChecked(body);
    return {
      ok: true,
      content: decoded.content,
      encoding: decoded.valid ? "utf8" : "non-utf8",
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function decodeChecked(buf: Buffer): { content: string; valid: boolean } {
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf), valid: true };
  } catch {
    return { content: new TextDecoder("utf-8").decode(buf), valid: false };
  }
}


export type WriteFileResult = { ok: true } | { ok: false; message: string };

async function realpathDeep(path: string): Promise<string> {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    cursor = parent;
  }
  try {
    return await realpath(cursor);
  } catch {
    return path;
  }
}

function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

export async function writeTextFileGuarded(
  targetPath: unknown,
  content: unknown,
  addBom: unknown,
  workspaceRoots: readonly string[],
): Promise<WriteFileResult> {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  if (typeof content !== "string") {
    return { ok: false, message: "Invalid content" };
  }
  if (content.includes("\0")) {
    return { ok: false, message: "Refusing to write NUL bytes." };
  }

  const resolved = resolve(targetPath.trim());
  const roots = workspaceRoots
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => resolve(r));

  if (!roots.some((root) => isInside(resolved, root))) {
    return { ok: false, message: "Path is outside registered workspaces." };
  }
  const [realTarget, ...realRoots] = await Promise.all([
    realpathDeep(resolved),
    ...roots.map((root) => realpathDeep(root)),
  ]);
  if (!realRoots.some((root) => isInside(realTarget, root))) {
    return { ok: false, message: "Path escapes workspace via symlinks." };
  }

  const buf = addBom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")])
    : Buffer.from(content, "utf8");
  const tmp = join(dirname(resolved), `.${basename(resolved)}${TEMP_FILE_SUFFIX}`);
  try {
    await writeFile(tmp, buf);
    await rename(tmp, resolved);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}


export type DevModeSearchResult =
  | { ok: true; files: Array<{ path: string; rel: string }>; truncated: boolean }
  | { ok: false; message: string };

export type DevModeIndexChunk = {
  requestId: number;
  files: Array<{ path: string; rel: string }>;
  done: boolean;
  truncated: boolean;
};

export type DevModeSearchOptions = {
  limit?: number;
  deadlineMs?: number;
  codeOnly?: boolean;
  listAll?: boolean;
  includeEngine?: boolean;
  engineOnly?: boolean;
};

const SEARCH_DEFAULT_MAX_RESULTS = 500;
const SEARCH_HARD_MAX_RESULTS = 200_000;
const SEARCH_MAX_DIRS = 200_000;
const SEARCH_DEFAULT_DEADLINE_MS = 8_000;
const SEARCH_MAX_DEADLINE_MS = 30_000;

function existingSubdirs(root: string, names: readonly string[]): string[] {
  const present = new Set<string>();
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory()) present.add(d.name.toLowerCase());
    }
  } catch {
    return [];
  }
  return names.filter((n) => present.has(n.toLowerCase()));
}

function matchScore(rel: string, q: string): number {
  let score = 0;
  if (q) {
    const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else score = 2;
  }
  if (isAssetPath(rel)) score += 3;
  if (rel.startsWith("Engine/")) score += 6;
  return score;
}

const activeSearches = new Map<string, number>();

const STREAM_BATCH_SIZE = 4_000;

export type DevModeWalkHooks = {
  onBatch?: (files: Array<{ path: string; rel: string }>) => void;
  batchSize?: number;
  cancelKey?: string;
};

export function cancelDevModeWalk(cancelKey: string): void {
  activeSearches.set(cancelKey, (activeSearches.get(cancelKey) ?? 0) + 1);
}

export type DevModeScanSeed = Pick<
  ScanOptions,
  "root" | "relPrefix" | "rank" | "unreal" | "onlyTopDirs" | "skipTopDirs"
> & { topDirs?: string[] };

export async function devModeScanSeeds(
  root: string,
  options: Pick<DevModeSearchOptions, "includeEngine" | "engineOnly">,
): Promise<DevModeScanSeed[]> {
  const engineSource = await resolveUeEngineSourceRoot(root);
  const engineOnly = options.engineOnly === true;
  const walkEngine =
    engineSource !== null && (options.includeEngine === true || engineOnly);
  const seeds: DevModeScanSeed[] = [];
  if (!engineOnly) {
    seeds.push({
      root,
      unreal: engineSource !== null || isUnrealProjectRoot(root),
      skipTopDirs: new Set(engineSource ? ["engine"] : []),
    });
  }
  if (walkEngine && engineSource) {
    const topDirs = existingSubdirs(engineSource, UNREAL_ENGINE_TOP_DIRS);
    seeds.push({
      root: engineSource,
      relPrefix: "Engine",
      rank: SCAN_RANK_ASSET,
      unreal: true,
      skipTopDirs: new Set(),
      ...(topDirs.length > 0
        ? { topDirs, onlyTopDirs: new Set(topDirs.map((n) => n.toLowerCase())) }
        : {}),
    });
  }
  return seeds;
}

export async function searchDevModeFiles(
  rootPath: unknown,
  query: unknown,
  options: DevModeSearchOptions = {},
  hooks: DevModeWalkHooks = {},
): Promise<DevModeSearchResult> {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q && !options.listAll) return { ok: true, files: [], truncated: false };
  const root = resolve(rootPath.trim());

  const cancelKey = hooks.cancelKey ?? root;
  const gen = (activeSearches.get(cancelKey) ?? 0) + 1;
  activeSearches.set(cancelKey, gen);
  const isCurrent = (): boolean => activeSearches.get(cancelKey) === gen;
  const onBatch = hooks.onBatch;
  const batchSize = Math.max(1, Math.floor(hooks.batchSize ?? STREAM_BATCH_SIZE));

  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? SEARCH_DEFAULT_MAX_RESULTS)),
    SEARCH_HARD_MAX_RESULTS,
  );
  const deadline =
    options.deadlineMs === 0
      ? Number.POSITIVE_INFINITY
      : Date.now() +
        Math.min(
          Math.max(
            500,
            Math.floor(options.deadlineMs ?? SEARCH_DEFAULT_DEADLINE_MS),
          ),
          SEARCH_MAX_DEADLINE_MS,
        );

  let files: Array<{ path: string; rel: string }> = [];
  let truncated = false;
  let emitted = 0;
  const include = (rel: string): boolean => {
    if (options.codeOnly && isAssetPath(rel)) return false;
    return !q || rel.toLowerCase().includes(q);
  };

  for (const { topDirs: _topDirs, ...seed } of await devModeScanSeeds(root, options)) {
    const outcome = await scanWorkspaceFiles({
      ...seed,
      include,
      deadline,
      maxDirs: SEARCH_MAX_DIRS,
      shouldStop: () => !isCurrent(),
      onFile: (file) => {
        if (emitted >= limit) {
          truncated = true;
          return false;
        }
        files.push({ path: file.absolute, rel: file.rel });
        emitted++;
        if (onBatch && files.length >= batchSize) {
          onBatch(files);
          files = [];
        }
        if (emitted >= limit) {
          truncated = true;
          return false;
        }
        return true;
      },
    });
    if (outcome.aborted || !isCurrent()) return { ok: true, files: [], truncated: true };
    if (outcome.truncated) truncated = true;
    if (outcome.truncated || emitted >= limit) break;
  }

  if (!isCurrent()) return { ok: true, files: [], truncated: true };
  if (onBatch) {
    if (files.length > 0) onBatch(files);
    return { ok: true, files: [], truncated };
  }
  files.sort((a, b) => {
    const diff = matchScore(a.rel, q) - matchScore(b.rel, q);
    if (diff !== 0) return diff;
    if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
    return a.rel.localeCompare(b.rel);
  });
  return { ok: true, files, truncated };
}

export async function resolveDevModeSourcePath(
  rootPath: unknown,
  sourcePath: unknown,
): Promise<string | null> {
  if (
    typeof rootPath !== "string" ||
    !rootPath.trim() ||
    typeof sourcePath !== "string" ||
    !sourcePath.trim()
  ) {
    return null;
  }

  const root = resolve(rootPath.trim());
  const raw = sourcePath.trim();
  const isRegularFile = async (candidate: string): Promise<boolean> => {
    try {
      return (await stat(candidate)).isFile();
    } catch {
      return false;
    }
  };

  if (isAbsolute(raw) && (await isRegularFile(raw))) return resolve(raw);

  const normalized = raw.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const engineRoot = await resolveUeEngineSourceRoot(root);

  const safeTail = (start: number): string[] | null => {
    const parts = normalized
      .slice(start)
      .split("/")
      .filter((part) => part.length > 0 && part !== ".");
    return parts.length > 0 && !parts.includes("..") ? parts : null;
  };

  const engineMarker = lower.lastIndexOf("/engine/");
  if (engineRoot && engineMarker >= 0) {
    const tail = safeTail(engineMarker + "/engine/".length);
    if (tail) {
      const candidate = join(engineRoot, ...tail);
      if (await isRegularFile(candidate)) return candidate;
    }
  }

  for (const marker of ["/source/", "/plugins/"]) {
    const at = lower.lastIndexOf(marker);
    if (at < 0) continue;
    const tail = safeTail(at + 1);
    if (!tail) continue;
    const candidate = join(root, ...tail);
    if (await isRegularFile(candidate)) return candidate;
  }

  const fileName = basename(normalized);
  if (!fileName) return null;
  const sourceParts = lower.split("/").filter(Boolean);
  const suffixScore = (candidate: string): number => {
    const parts = candidate
      .toLowerCase()
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    let score = 0;
    while (
      score < sourceParts.length &&
      score < parts.length &&
      sourceParts[sourceParts.length - 1 - score] ===
        parts[parts.length - 1 - score]
    ) {
      score++;
    }
    return score;
  };
  const best = (
    files: Array<{ path: string; rel: string }>,
  ): string | null =>
    [...files].sort((a, b) => suffixScore(b.path) - suffixScore(a.path))[0]
      ?.path ?? null;

  const looksLikeEngine = engineMarker >= 0;
  if (!looksLikeEngine) {
    const project = await searchDevModeFiles(
      root,
      fileName,
      { codeOnly: true, limit: 100, deadlineMs: 5_000 },
      { cancelKey: `debug-source:${root}` },
    );
    if (project.ok && project.files.length > 0) return best(project.files);
  }

  if (engineRoot) {
    const engine = await searchDevModeFiles(
      root,
      fileName,
      {
        codeOnly: true,
        engineOnly: true,
        limit: 100,
        deadlineMs: 10_000,
      },
      { cancelKey: `debug-source:${root}` },
    );
    if (engine.ok && engine.files.length > 0) return best(engine.files);
  }

  return null;
}


export type DevModeFsEventKind = "add" | "change" | "unlink";
export type DevModeFsEvent = {
  rootPath: string;
  events: Array<{ path: string; kind: DevModeFsEventKind }>;
};

type WatchEntry = { watcher: FSWatcher; close: () => void };
const watchers = new Map<string, WatchEntry>();

const WATCHED_REL_PATHS: ReadonlySet<string> = new Set([".larry/tasks.json"]);

function normalizeWatchRelPath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function isWatchableRelPath(rel: string, rules: ScanRules = BROWSE_RULES): boolean {
  const normalized = normalizeWatchRelPath(rel);
  if (!normalized) return false;
  if (WATCHED_REL_PATHS.has(normalized)) return true;
  return !isSkippedRelPath(normalized, rules);
}

export function startDevModeWatch(
  rootPath: unknown,
  broadcast: (payload: DevModeFsEvent) => void,
): { ok: true } | { ok: false; message: string } {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  const root = resolve(rootPath.trim());
  if (!existsSync(root)) {
    return { ok: false, message: "Watch root does not exist." };
  }
  const existing = watchers.get(root);
  if (existing) return { ok: true };

  const pending = new Map<string, "change" | "rename">();
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    timer = null;
    if (pending.size === 0) return;
    const events = [...pending.entries()].map(([path, raw]) => ({
      path,
      kind:
        raw === "change"
          ? ("change" as const)
          : existsSync(path)
            ? ("add" as const)
            : ("unlink" as const),
    }));
    pending.clear();
    broadcast({ rootPath: root, events });
  };

  const onEvent = (event: string, filename: string | Buffer | null): void => {
    if (!filename) return;
    const rel = filename.toString();
    if (!isWatchableRelPath(rel)) return;
    pending.set(join(root, rel), event === "change" ? "change" : "rename");
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, onEvent);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const entry: WatchEntry = {
    watcher,
    close: () => {
      if (timer) clearTimeout(timer);
      pending.clear();
      watcher.close();
    },
  };
  watchers.set(root, entry);
  return { ok: true };
}

export function stopDevModeWatch(rootPath: unknown): void {
  if (typeof rootPath !== "string" || !rootPath.trim()) return;
  const root = resolve(rootPath.trim());
  const entry = watchers.get(root);
  if (!entry) return;
  watchers.delete(root);
  entry.close();
}

export function stopAllDevModeWatches(): void {
  for (const entry of watchers.values()) entry.close();
  watchers.clear();
}
