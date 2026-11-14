/**
 * Dev Mode file-system bridge.
 *
 * IPC surface (registered in main/index.ts):
 *   devmode:listDir        — single-level lazy listing for Solution Outline
 *   devmode:watch/unwatch  — recursive watch, debounced, ignore-filtered
 *   fs:readFileForEditor   — text read + BOM / non-UTF-8 detection + mtime
 *   fs:writeTextFile       — guarded atomic write (workspace prefix + symlink
 *                            escape check, tmp+rename)
 *
 * Ignore rules mirror the plan: bin obj .git .svn .vs node_modules packages
 * TestResults dist out (+ hidden dirs, .DS_Store / Thumbs.db noise).
 */
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  isUnrealProjectRoot,
  resolveUeEngineSourceRoot,
} from "../unreal/engineRoot.js";

export { resolveUeEngineSourceRoot };

export const DEVMODE_IGNORED_DIRS = new Set([
  "bin", "obj", "node_modules", "packages", "TestResults", "dist", "out",
]);

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const TMP_SUFFIX = ".jbt.tmp";
export const EDITOR_FILE_MAX_BYTES = 4_000_000;
const WATCH_DEBOUNCE_MS = 150;

// --------------------------------------------------------------------- list

export type DevModeDirEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  ext: string;
  /**
   * Launchable from the tree (double-click = run). Single source: win32 is
   * a naming convention (no exec bit), posix is the exec bit — both decided
   * main-side so the renderer never re-derives the platform rules.
   */
  executable?: boolean;
};

export type DevModeListResult =
  | { ok: true; entries: DevModeDirEntry[] }
  | { ok: false; message: string };

/** UE-generated vcxproj files run multi-MB — the 1MB preview cap doesn't fit. */
export const PROJECT_FILE_MAX_BYTES = 12_000_000;

export type ProjectFileContentResult =
  | { ok: true; content: string; sizeBytes: number }
  | { ok: false; message: string };

/**
 * Read a .vcxproj / .csproj (or .sln) into a renderer-ready string.
 * Same shape as readFileForEditor but with a project-file-sized cap and no
 * editor semantics (no BOM re-add contract, no mtime) — this is a one-way
 * read for tree building, never written back.
 */
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
    // Strip UTF-8 BOM if present; parser tolerates it either way.
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

function isIgnoredDirName(name: string): boolean {
  return name.startsWith(".") || DEVMODE_IGNORED_DIRS.has(name);
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
        if (isIgnoredDirName(d.name)) continue;
        entries.push({
          name: d.name,
          path: join(dir, d.name),
          kind: "dir",
          ext: "",
        });
      } else if (d.isFile()) {
        if (IGNORED_FILES.has(d.name) || d.name.endsWith(TMP_SUFFIX)) continue;
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
      // Symlinks and other kinds are skipped — no escape hatches.
    }
    // Posix: executable is the exec bit, not a name. One stat per file —
    // single-level lazy listings stay small enough for it.
    if (process.platform !== "win32") {
      await Promise.all(
        entries
          .filter((e) => e.kind === "file")
          .map(async (e) => {
            // macOS installer images carry no exec bit but still
            // double-click into a system handler — name-based, no stat.
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
              // Vanished between readdir and stat; the watch refresh drops it.
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

// ---------------------------------------------------- executable launching

/** Windows executables are a naming convention (no exec bit on NTFS). */
export const WINDOWS_EXECUTABLE_EXTS = new Set([
  "exe", "bat", "cmd", "com", "lnk", "msi",
]);

/** macOS double-click semantics: these run inside Terminal via the open verb. */
const POSIX_TERMINAL_EXTS = new Set(["command", "terminal"]);

/**
 * macOS payloads without an exec bit whose double-click hands off to a
 * system handler (.dmg mounts, .pkg opens Installer) — like Finder does.
 */
const POSIX_OPENABLE_EXTS = new Set(["dmg", "pkg"]);

export type ExecutableLaunchPlan =
  /** Hand to the OS open verb (ShellExecute on win, LaunchServices on mac). */
  | { kind: "open-path" }
  /** Detached spawn, cwd = the file's directory, output discarded. */
  | { kind: "spawn" }
  | { kind: "reject"; reason: string };

/**
 * Pure launch planner — how the OS shell would treat a double-click on this
 * file. The electron side effects (shell.openPath / spawn) live in
 * devmodeRun.ts; keeping this pure keeps it testable under plain node.
 */
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
  // macOS installer images: the open verb mounts / hands to Installer
  // regardless of the exec bit (they never carry one).
  if (input.platform === "darwin" && POSIX_OPENABLE_EXTS.has(ext)) {
    return { kind: "open-path" };
  }
  if (!input.executableBit) {
    return { kind: "reject", reason: "file is not executable (chmod +x to run it)" };
  }
  // .command/.terminal scripts are Terminal citizens — the open verb gives
  // them a Terminal window with visible output, like Finder does.
  return POSIX_TERMINAL_EXTS.has(ext)
    ? { kind: "open-path" }
    : { kind: "spawn" };
}

// --------------------------------------------------------------------- read

export type EditorFileResult =
  | {
      ok: true;
      content: string;
      /** utf8 = plain · utf8-bom = BOM stripped (re-added on save) · non-utf8 = lossy, read-only. */
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

/** Strict UTF-8 check; falls back to lossy decode so non-UTF-8 files stay viewable. */
function decodeChecked(buf: Buffer): { content: string; valid: boolean } {
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf), valid: true };
  } catch {
    return { content: new TextDecoder("utf-8").decode(buf), valid: false };
  }
}

// --------------------------------------------------------------------- write

export type WriteFileResult = { ok: true } | { ok: false; message: string };

/** realpath of the deepest existing ancestor (path may not exist yet). */
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

  // Guard 1: lexical prefix inside a registered workspace.
  if (!roots.some((root) => isInside(resolved, root))) {
    return { ok: false, message: "Path is outside registered workspaces." };
  }
  // Guard 2: symlink escape — compare realpaths.
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
  const tmp = join(dirname(resolved), `.${basename(resolved)}${TMP_SUFFIX}`);
  try {
    await writeFile(tmp, buf);
    await rename(tmp, resolved);
    return { ok: true };
  } catch (err) {
    // Leftover tmp is harmless: filtered from listings and watch events.
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ------------------------------------------------------------------- search

export type DevModeSearchResult =
  | { ok: true; files: Array<{ path: string; rel: string }>; truncated: boolean }
  | { ok: false; message: string };

/** One streamed batch of a file-index walk (`devmode:indexChunk`). */
export type DevModeIndexChunk = {
  requestId: number;
  files: Array<{ path: string; rel: string }>;
  /** Final message of the walk; `files` may be empty. */
  done: boolean;
  /** Set on the final message when the walk hit a budget. */
  truncated: boolean;
};

export type DevModeSearchOptions = {
  /** Result cap (clamped to SEARCH_HARD_MAX_RESULTS). */
  limit?: number;
  /**
   * Walk deadline override (ms, clamped to SEARCH_MAX_DEADLINE_MS).
   * `0` disables the wall-clock deadline for cancellable background indexes;
   * result and directory safety caps still apply.
   */
  deadlineMs?: number;
  /** Drop asset/binary extensions (.uasset, .png, .dll …) — code + text only. */
  codeOnly?: boolean;
  /** Return every file regardless of query (empty query still walks). */
  listAll?: boolean;
  /**
   * Also walk `<root>/Engine` when the workspace is a source-built UE
   * engine. Off by default: the engine adds ~35k dirs / ~2s per walk.
   */
  includeEngine?: boolean;
  /**
   * Walk *only* the engine seed and skip the project root. Lets Quick Open
   * load the engine as a second, background pass without re-walking the
   * project tree it already cached; the two results are disjoint.
   */
  engineOnly?: boolean;
};

const SEARCH_DEFAULT_MAX_RESULTS = 500;
/**
 * Engine trees are far bigger than a game project (NF ships ~20k files, the
 * engine's code-only tree is several times that), so the ceiling has to clear
 * both. Callers still pass their own, smaller `limit`.
 */
const SEARCH_HARD_MAX_RESULTS = 200_000;
const SEARCH_MAX_DIRS = 200_000;
const SEARCH_DEFAULT_DEADLINE_MS = 8_000;
const SEARCH_MAX_DEADLINE_MS = 30_000;

/**
 * UE directory blacklist (any depth, case-insensitive). Content holds
 * .uasset noise (20k dirs in NF), Intermediate/Binaries/DerivedDataCache
 * are generated — together ~98% of the tree and 0% of a filename query.
 */
const UE_EXCLUDED_DIRS = new Set([
  "content", "intermediate", "binaries", "deriveddatacache", "saved",
  "cooked", "staging", "documentation", "featurepacks", "samples",
  "extras", "templates", "__externalactors__", "__externalobjects__",
]);

/** Case-insensitive pick of the subdirs that actually exist. */
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

/** UE source dirs worth seeding at the engine root. */
const UE_ENGINE_DIRS = ["Source", "Plugins", "Config", "Shaders", "Programs"];
/** Engine dir name, lower-cased, for the root seed's skip rule. */
const ENGINE_DIR_NAME = "engine";

/**
 * Walk priority: source trees first, asset/generated trees last. UE games
 * bury ~5k code files under 300k assets (Content 20k dirs, Intermediate
 * 3.3k) — a plain BFS exhausts its budget on `.uasset` noise and never
 * reaches `Source/`. Rank is monotonic along a path (child rank =
 * max(parent, own)), so buckets never starve each other.
 */
const SEARCH_PRIORITY_DIRS = new Set([
  "source", "src", "plugins", "config", "include", "inc", "private",
  "public", "classes", "shader", "shaders", "scripts",
]);

const SEARCH_DEPRIORITIZED_DIRS = new Set([
  "content", "intermediate", "binaries", "deriveddatacache", "saved",
  "build", "builds", "docs", "doc", "thirdparty", "extern", "movies",
  "textures", "dcc", "art", "rawcontent", "cooked", "staging",
]);

/** Binary / generated payloads — never useful in a filename search. */
const SEARCH_ASSET_EXTS = new Set([
  "uasset", "umap", "uexp", "ubulk", "ufont", "upk",
  "png", "jpg", "jpeg", "gif", "bmp", "tga", "psd", "exr", "hdr", "dds",
  "ktx", "webp", "svg",
  "wav", "mp3", "ogg", "flac", "aac", "wem", "bnk",
  "fbx", "obj", "abc", "usd", "usda", "usdc", "blend", "max", "ma", "mb",
  "dll", "exe", "pdb", "lib", "so", "dylib", "bin", "o",
  "ttf", "otf", "woff", "woff2",
  "mp4", "mov", "avi", "webm",
  "zip", "7z", "rar", "gz", "tar", "pak", "ucas", "utoc",
  "pdf", "db", "sqlite", "mdb", "dat", "log",
]);

/** Walk bucket: 0 = source trees, 1 = neutral, 2 = asset/generated trees. */
const RANK_SOURCE = 0;
const RANK_NEUTRAL = 1;
const RANK_ASSET = 2;

type SearchSeed = {
  dir: string;
  rel: string;
  rank: typeof RANK_SOURCE | typeof RANK_NEUTRAL | typeof RANK_ASSET;
  /** UE scoping on — apply the asset/generated blacklist while descending. */
  ue: boolean;
  /** Descend only into these child dir names, lowercased (engine fan-out). */
  only?: Set<string>;
  /** Skip this child dir name (lower-cased) — handled by its own seed. */
  skip?: string;
};

function dirRankOf(name: string): typeof RANK_SOURCE | typeof RANK_NEUTRAL | typeof RANK_ASSET {
  const lower = name.toLowerCase();
  if (SEARCH_PRIORITY_DIRS.has(lower)) return RANK_SOURCE;
  if (SEARCH_DEPRIORITIZED_DIRS.has(lower)) return RANK_ASSET;
  return RANK_NEUTRAL;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Match quality for ranking: basename prefix beats basename substring beats
 * path-only hit; assets sink to the bottom so `NFCharacter` surfaces
 * `Source/…/NFCharacter.h` ahead of `Content/…/BP_NFCharacter.uasset`.
 */
function matchScore(rel: string, q: string): number {
  let score = 0;
  if (q) {
    const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else score = 2;
  }
  if (SEARCH_ASSET_EXTS.has(extOf(rel))) score += 3;
  // Engine code is a valid hit but always ranks below project code.
  if (rel.startsWith("Engine/")) score += 6;
  return score;
}

/**
 * Latest-walk-wins per cancel key. Walks now span seconds on huge trees, so a
 * fast typist can have several in flight; each superseded walk bails at its
 * next directory read instead of finishing a pointless 300k-entry crawl.
 *
 * The key defaults to the root path, which is what makes latest-wins work for
 * a search box. Long-lived index walks pass their own key so an unrelated
 * keystroke on the same workspace cannot cancel them.
 */
const activeSearches = new Map<string, number>();

/** Default flush size for streaming walks. */
const STREAM_BATCH_SIZE = 4_000;

export type DevModeWalkHooks = {
  /**
   * Streaming sink. When present the walk flushes batches as it goes instead
   * of accumulating, and the resolved result carries an empty `files` array.
   * Batches arrive in walk order (source trees first), not relevance order —
   * streaming callers rank client-side anyway.
   */
  onBatch?: (files: Array<{ path: string; rel: string }>) => void;
  /** Flush threshold for `onBatch` (default STREAM_BATCH_SIZE). */
  batchSize?: number;
  /** Cancellation namespace; defaults to the resolved root path. */
  cancelKey?: string;
};

/** Supersede any walk running under `cancelKey`; it bails at its next dir read. */
export function cancelDevModeWalk(cancelKey: string): void {
  activeSearches.set(cancelKey, (activeSearches.get(cancelKey) ?? 0) + 1);
}

/**
 * Recursive filename filter for the Solution Outline search box and Quick
 * Open. Same ignore rules as the tree listing; priority-bucket BFS with
 * budgets (results, dirs, wall clock) so giant workspaces cannot stall the
 * walk — and when they do cut it short, source trees are already covered.
 */
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
  let visitedDirs = 0;
  // Streaming hands `files` off and starts a fresh buffer, so the budget has
  // to be tracked separately from the buffer length.
  let emitted = 0;

  // Detect the engine root (local / sibling / registry). Even with the engine
  // walk disarmed, the root seed would otherwise crawl Engine/ by plain
  // recursion (its Content alone is 20k dirs).
  const engineSource = await resolveUeEngineSourceRoot(root);
  const engineOnly = options.engineOnly === true;
  const walkEngine =
    engineSource !== null && (options.includeEngine === true || engineOnly);
  // Engine-only asked for a tree this workspace does not have.
  if (engineOnly && !walkEngine) return { ok: true, files: [], truncated: false };
  // UE tree: keep the whole tree but blacklist asset/generated dirs at any
  // depth. Content alone is 20k of NF's 33k dirs; Source/Plugins/Config/
  // Script/Build survive with no allowlist to maintain. An engine root has
  // no .uproject but the same Content/Binaries noise, so it scopes too.
  const ueRoot = engineSource !== null || isUnrealProjectRoot(root);
  // The root seed must never crawl into Engine/ on its own — the engine has
  // its own seed (armed) or is out of scope entirely (disarmed).
  const rootSeed: SearchSeed = {
    dir: root,
    rel: "",
    rank: RANK_NEUTRAL,
    ue: ueRoot,
    // A sibling/registry engine lives outside the project, so the local
    // skip guard would not apply — but the cheap lookup is harmless.
    ...(engineSource ? { skip: ENGINE_DIR_NAME } : {}),
  };
  const seeds: SearchSeed[] = engineOnly ? [] : [rootSeed];
  if (walkEngine && engineSource) {
    // One seed on Engine/ itself; subdirs descend from it. Seeding
    // Engine/Source + Engine/Plugins separately would double-count.
    const engineSeed: SearchSeed = {
      dir: engineSource,
      rel: "Engine",
      rank: RANK_ASSET, // project code ranks above engine code
      ue: true,
    };
    const only = new Set(
      existingSubdirs(engineSource, UE_ENGINE_DIRS).map((n) => n.toLowerCase()),
    );
    if (only.size > 0) engineSeed.only = only;
    seeds.push(engineSeed);
  }

  // Bucket 0 = source trees, 1 = neutral, 2 = asset/generated + engine code.
  const buckets: SearchSeed[][] = [
    seeds.filter((s) => s.rank === RANK_SOURCE),
    seeds.filter((s) => s.rank === RANK_NEUTRAL),
    seeds.filter((s) => s.rank === RANK_ASSET),
  ];

  for (let bucket = 0; bucket < 3; bucket++) {
    const queue = buckets[bucket]!;
    for (let head = 0; head < queue.length; head++) {
      if (visitedDirs >= SEARCH_MAX_DIRS || Date.now() > deadline) {
        truncated = true;
        break;
      }
      if (!isCurrent()) return { ok: true, files: [], truncated: true };
      const { dir, rel, rank, ue, only, skip } = queue[head]!;
      visitedDirs++;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable dir — skip, not fatal
      }
      for (const d of dirents) {
        if (d.isDirectory()) {
          if (isIgnoredDirName(d.name)) continue;
          if (ue && UE_EXCLUDED_DIRS.has(d.name.toLowerCase())) continue;
          const lowerName = d.name.toLowerCase();
          if (only && !only.has(lowerName)) continue;
          if (skip && lowerName === skip) continue;
          const childRank = Math.max(rank, dirRankOf(d.name)) as 0 | 1 | 2;
          buckets[childRank]!.push({
            dir: join(dir, d.name),
            rel: rel ? `${rel}/${d.name}` : d.name,
            rank: childRank,
            ue,
          });
        } else if (d.isFile()) {
          if (IGNORED_FILES.has(d.name) || d.name.endsWith(TMP_SUFFIX)) continue;
          if (options.codeOnly && SEARCH_ASSET_EXTS.has(extOf(d.name))) continue;
          const fileRel = rel ? `${rel}/${d.name}` : d.name;
          if (q && !fileRel.toLowerCase().includes(q)) continue;
          files.push({ path: join(dir, d.name), rel: fileRel });
          emitted++;
          if (onBatch && files.length >= batchSize) {
            onBatch(files);
            files = [];
          }
          if (emitted >= limit) {
            truncated = true;
            break;
          }
        }
      }
      if (emitted >= limit) {
        truncated = true;
        break;
      }
    }
    // Enough hits out of the source trees — skip the asset crawl entirely.
    if (emitted >= limit) {
      truncated = true;
      break;
    }
  }

  if (!isCurrent()) return { ok: true, files: [], truncated: true };
  if (onBatch) {
    if (files.length > 0) onBatch(files);
    // Streamed callers already hold every batch; relevance ordering is theirs.
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

// ---------------------------------------------------- debug source resolve

/**
 * Resolve a DAP stack-frame source path onto this machine without loading or
 * indexing debug symbols.
 *
 * LLDB commonly reports the build machine's absolute path, but UE paths retain
 * a stable tail such as `Engine/Source/Runtime/Core/...`. The common case is
 * therefore one engine-root lookup plus one `stat`, not a recursive crawl.
 * Filename search is only a fallback for adapters that provide a basename or
 * a path whose directory layout no longer matches.
 */
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

  // The adapter may already report a valid path on this machine.
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

  // Build-machine UE path:
  //   D:/build/++UE5/Sync/Engine/Source/... -> <local Engine>/Source/...
  const engineMarker = lower.lastIndexOf("/engine/");
  if (engineRoot && engineMarker >= 0) {
    const tail = safeTail(engineMarker + "/engine/".length);
    if (tail) {
      const candidate = join(engineRoot, ...tail);
      if (await isRegularFile(candidate)) return candidate;
    }
  }

  // Build-machine project/plugin path:
  //   D:/build/Game/Source/...  -> <workspace>/Source/...
  //   D:/build/Game/Plugins/... -> <workspace>/Plugins/...
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

  // On-demand Engine fallback. This scans only Engine source dirs and does not
  // touch PDBs; it is used only when the direct stable-suffix mapping failed.
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

// -------------------------------------------------------------------- watch

export type DevModeFsEventKind = "add" | "change" | "unlink";
export type DevModeFsEvent = {
  rootPath: string;
  events: Array<{ path: string; kind: DevModeFsEventKind }>;
};

type WatchEntry = { watcher: FSWatcher; close: () => void };
const watchers = new Map<string, WatchEntry>();

function isIgnoredRelPath(rel: string): boolean {
  const segments = rel.split(/[\\/]/);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    if (last) {
      if (IGNORED_FILES.has(seg) || seg.endsWith(TMP_SUFFIX)) return true;
    } else if (isIgnoredDirName(seg)) {
      return true;
    }
  }
  return false;
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
    if (!filename) return; // root-level noise without a name
    const rel = filename.toString();
    if (!rel || isIgnoredRelPath(rel)) return;
    pending.set(join(root, rel), event === "change" ? "change" : "rename");
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  };

  let watcher: FSWatcher;
  try {
    // recursive is native on macOS/Windows; Linux throws → renderer degrades.
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
