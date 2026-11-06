/**
 * VCS badge status for the Dev Mode Solution Outline.
 *
 * ⚠ PERFORMANCE CONTRACT (learned the hard way on large SVN working
 * copies — see src/svn/collect.ts for the heavyweight path): this module
 * runs STATUS ONLY. It never runs `svn diff` / `git diff`, never reads
 * file contents, never runs `svn cat`. Badges need letters, not line
 * counts; a 100k-file WC gets one `svn status` (local-only, no `-u`) or
 * one `git status --porcelain -z`, nothing more.
 *
 * Scheduling guards against event storms (agent writing files, builds):
 *  - per-root in-flight coalescing (concurrent callers share one run)
 *  - per-root min-interval throttle (repeat requests inside the window
 *    get the cached result, no new process)
 *  - renderer additionally debounces fs events before even calling here
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { ipcMain, shell } from "electron";
import { parseSvnStatus, type SvnStatusKind } from "../svn/parseSvn.js";
import { getVcsBlame } from "./vcsBlame.js";

export type VcsKind = "git" | "svn" | "none";

export type VcsBadge = "M" | "A" | "D" | "U" | "C";

export type VcsEntry = { path: string; status: VcsBadge };

export type VcsStatusResult =
  | { ok: true; vcs: VcsKind; entries: VcsEntry[]; aheadCount: number }
  | { ok: false; message: string };

export type VcsAction =
  | { kind: "git-stage"; paths: string[] }
  | { kind: "git-unstage"; paths: string[] }
  /** Tracked changes only — untracked discard is a file deletion (out of scope). */
  | { kind: "git-discard"; paths: string[] }
  | { kind: "svn-revert"; paths: string[] }
  | { kind: "svn-update"; paths: string[] };

const STATUS_TIMEOUT_MS = 8000;
/** Repeat status calls within this window reuse the cached result. */
const MIN_INTERVAL_MS = 1000;

const SVN_KIND_TO_BADGE: Record<SvnStatusKind, VcsBadge | null> = {
  modified: "M",
  replaced: "M",
  added: "A",
  deleted: "D",
  missing: "D",
  untracked: "U",
  conflicted: "C",
  obscured: null,
};

function run(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      args[0]!,
      args.slice(1),
      {
        cwd: root,
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: number }).code !== "number") {
          reject(err); // spawn failure (ENOENT — client not installed)
          return;
        }
        resolve({
          code: err ? Number((err as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/** XY porcelain pair → badge letter. */
function gitBadge(xy: string): VcsBadge | null {
  if (xy === "??") return "U";
  if (xy === "!!") return null; // ignored — not surfaced
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (
    x === "U" ||
    y === "U" ||
    (x === "D" && y === "D") ||
    (x === "A" && y === "A")
  ) {
    return "C";
  }
  if (x === "A" || y === "A") return "A";
  if (x === "D" || y === "D") return "D";
  return "M";
}

/** git status --porcelain -z → entries (rename source records skipped). */
export function parseGitZ(out: string): VcsEntry[] {
  const parts = out.split("\0").filter((p) => p.length > 0);
  const entries: VcsEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    if (!path) continue;
    const badge = gitBadge(xy);
    if (badge) entries.push({ path, status: badge });
    if (xy[0] === "R" || xy[1] === "R") i++; // next NUL part = rename source
  }
  return entries;
}

/** svn status (via the shared pure parser) → badge entries. */
export function parseSvnBadges(out: string): VcsEntry[] {
  const entries: VcsEntry[] = [];
  for (const entry of parseSvnStatus(out)) {
    const badge = SVN_KIND_TO_BADGE[entry.kind];
    if (badge) entries.push({ path: entry.path, status: badge });
  }
  return entries;
}

type CacheSlot = {
  result: VcsStatusResult | null;
  at: number;
  inflight: Promise<VcsStatusResult> | null;
};

const cache = new Map<string, CacheSlot>();

function slotOf(root: string): CacheSlot {
  const key = resolve(root);
  let slot = cache.get(key);
  if (!slot) {
    slot = { result: null, at: 0, inflight: null };
    cache.set(key, slot);
  }
  return slot;
}

/** posix-normalize so renderer lookups are separator-agnostic. */
function toAbs(base: string, relPath: string): string {
  const joined = relPath.startsWith("/")
    ? relPath
    : `${base.replace(/\/+$/, "")}/${relPath}`;
  return joined.replace(/\\/g, "/");
}

async function runStatusOnce(root: string): Promise<VcsStatusResult> {
  try {
    // git rev-parse first: porcelain paths are REPO-ROOT-relative (verified
    // empirically), so joining them under `root` breaks whenever the
    // workspace is a subdirectory of the repository.
    const toplevel = await run(root, ["git", "rev-parse", "--show-toplevel"]);
    if (toplevel.code === 0) {
      const base = toplevel.stdout.trim();
      const status = await run(root, [
        "git",
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=all",
      ]);
      if (status.code === 0) {
        const entries = parseGitZ(status.stdout).map((e) => ({
          path: toAbs(base, e.path),
          status: e.status,
        }));
        return {
          ok: true,
          vcs: "git",
          entries,
          aheadCount: await countUnpushed(root),
        };
      }
    }
  } catch {
    // git not installed / not a repo — fall through to svn
  }
  try {
    // Local-only by design: no `--show-updates`, so it never hits network.
    // svn status paths are relative to cwd (= requested root).
    const svn = await run(root, ["svn", "status", "--non-interactive"]);
    if (svn.code === 0) {
      const entries = parseSvnBadges(svn.stdout).map((e) => ({
        path: toAbs(root, e.path),
        status: e.status,
      }));
      return { ok: true, vcs: "svn", entries, aheadCount: 0 };
    }
    if (/not a working copy/i.test(svn.stderr)) {
      return { ok: true, vcs: "none", entries: [], aheadCount: 0 };
    }
    return { ok: false, message: svn.stderr.trim() || "svn status failed" };
  } catch {
    return { ok: true, vcs: "none", entries: [], aheadCount: 0 };
  }
}

/** Commits on HEAD missing from upstream; 0 when no upstream / failure. */
async function countUnpushed(root: string): Promise<number> {
  try {
    const res = await run(root, [
      "git",
      "rev-list",
      "--count",
      "@{upstream}..HEAD",
    ]);
    const n =
      res.code === 0 ? Number.parseInt(res.stdout.trim(), 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Throttled + coalesced status (see header contract). */
export function getVcsStatus(root: string): Promise<VcsStatusResult> {
  const slot = slotOf(root);
  if (slot.inflight) return slot.inflight;
  const fresh =
    slot.result !== null && Date.now() - slot.at < MIN_INTERVAL_MS;
  if (fresh && slot.result) return Promise.resolve(slot.result);
  const p = runStatusOnce(root)
    .then((result) => {
      slot.result = result;
      slot.at = Date.now();
      return result;
    })
    .finally(() => {
      if (slot.inflight === p) slot.inflight = null;
    });
  slot.inflight = p;
  return p;
}

// ------------------------------------------------- per-file line diff

export type VcsDiffLine = { line: number; kind: "M" | "A" };

/** Deleted block anchored to the new-file line it precedes (1-based). */
export type VcsDiffDeleteMark = { beforeLine: number; count: number };

export type VcsFileDiff = {
  /** Untracked new file — highlight every line as added. */
  allAdded: boolean;
  lines: VcsDiffLine[];
  deleted: VcsDiffDeleteMark[];
};

const EMPTY_DIFF: VcsFileDiff = { allAdded: false, lines: [], deleted: [] };

/**
 * Parse ONE unified diff (single file) into new-file line marks.
 * Runs of `+` only → A; mixed `+`/`-` → M; `-` only → delete mark
 * anchored at the new-file line the block precedes (clamped to line 1).
 */
export function parseUnifiedDiff(out: string): {
  lines: VcsDiffLine[];
  deleted: VcsDiffDeleteMark[];
} {
  const lines: VcsDiffLine[] = [];
  const deleted: VcsDiffDeleteMark[] = [];
  let newLine = 0;
  let runStart = 0;
  let plusCount = 0;
  let minusCount = 0;
  let inRun = false;

  const flush = (): void => {
    if (!inRun) return;
    if (plusCount > 0) {
      const kind: "M" | "A" = minusCount > 0 ? "M" : "A";
      for (let i = 1; i <= plusCount; i++) {
        lines.push({ line: runStart + i, kind });
      }
    } else if (minusCount > 0) {
      // Anchor at the new-file line FOLLOWING the deleted block
      // (`newLine` = last line emitted before the run).
      deleted.push({
        beforeLine: Math.max(1, newLine + 1),
        count: minusCount,
      });
    }
    inRun = false;
    plusCount = 0;
    minusCount = 0;
  };

  for (const raw of out.split("\n")) {
    const hunk = raw.match(/^@@ -(?:\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flush();
      newLine = Number(hunk[1]!) - 1; // pre-incremented per new-file line
      continue;
    }
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("\\")
    ) {
      continue;
    }
    if (raw.startsWith("+")) {
      if (!inRun) {
        inRun = true;
        runStart = newLine;
      }
      plusCount++;
      newLine++;
      continue;
    }
    if (raw.startsWith("-")) {
      if (!inRun) {
        inRun = true;
        runStart = newLine;
      }
      minusCount++;
      continue;
    }
    // context line closes the run
    flush();
    newLine++;
  }
  flush();
  return { lines, deleted };
}

/**
 * Line diff for ONE file (worktree vs HEAD / BASE). Perf: clean files are
 * filtered via the cached status (no diff spawn); only dirty files pay
 * one single-file diff — never a full-tree diff.
 */
export async function getVcsFileDiff(
  root: string,
  absPath: string,
): Promise<{ ok: true; diff: VcsFileDiff } | { ok: false; message: string }> {
  const status = await getVcsStatus(root);
  if (!status.ok) return { ok: false, message: status.message };
  const rel = normalizeRel(root, absPath);
  if (rel === null) return { ok: true, diff: EMPTY_DIFF };
  const entry = status.entries.find((e) => {
    const eAbs = e.path;
    return eAbs === absPath.replace(/\\/g, "/") ||
      eAbs.endsWith(`/${rel}`);
  });
  if (!entry) return { ok: true, diff: EMPTY_DIFF }; // clean — no diff spawn
  if (entry.status === "U" || entry.status === "A") {
    return { ok: true, diff: { ...EMPTY_DIFF, allAdded: true } };
  }
  if (status.vcs === "git") {
    try {
      const res = await run(root, ["git", "diff", "HEAD", "--", rel]);
      if (res.code === 0) {
        return { ok: true, diff: parseToDiff(res.stdout) };
      }
      return { ok: false, message: res.stderr.trim() || "git diff failed" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  if (status.vcs === "svn") {
    try {
      const res = await run(root, ["svn", "diff", "--non-interactive", "--", rel]);
      if (res.code === 0) {
        return { ok: true, diff: parseToDiff(res.stdout) };
      }
      return { ok: false, message: res.stderr.trim() || "svn diff failed" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, diff: EMPTY_DIFF };
}

export type VcsFileBaseResult =
  | {
      ok: true;
      kind: "git" | "svn";
      /** HEAD for Git, BASE for SVN; empty for locally added files. */
      content: string;
      tracked: boolean;
    }
  | { ok: false; message: string };

/**
 * Read the repository-side version used by Monaco's side-by-side diff.
 * The right model remains the live editor model, including unsaved changes.
 */
export async function getVcsFileBase(
  root: string,
  absPath: string,
): Promise<VcsFileBaseResult> {
  const status = await getVcsStatus(root);
  if (!status.ok) return { ok: false, message: status.message };
  const rel = normalizeRel(root, absPath);
  if (rel === null) {
    return { ok: false, message: "File is outside the workspace root" };
  }
  if (status.vcs === "none") {
    return { ok: false, message: "Workspace has no version control" };
  }
  const entry = status.entries.find((row) => {
    const rowAbs = row.path.replace(/\\/g, "/");
    return rowAbs === absPath.replace(/\\/g, "/") || rowAbs.endsWith(`/${rel}`);
  });
  if (entry?.status === "U" || entry?.status === "A") {
    return { ok: true, kind: status.vcs, content: "", tracked: false };
  }

  try {
    let res: { code: number; stdout: string; stderr: string };
    if (status.vcs === "git") {
      // `git show REV:path` is repository-root-relative, while Dev Mode's
      // workspace may be a nested folder inside that repository.
      const prefixResult = await run(root, ["git", "rev-parse", "--show-prefix"]);
      const prefix = prefixResult.code === 0 ? prefixResult.stdout.trim() : "";
      res = await run(root, ["git", "show", `HEAD:${prefix}${rel}`]);
    } else {
      res = await run(root, ["svn", "cat", "-r", "BASE", "--", rel]);
    }
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      if (
        status.vcs === "git" &&
        /does not exist in|exists on disk, but not in|invalid object name|bad revision/i.test(
          detail,
        )
      ) {
        return { ok: true, kind: "git", content: "", tracked: false };
      }
      return {
        ok: false,
        message:
          detail ||
          `Could not read ${status.vcs === "git" ? "HEAD" : "BASE"} version`,
      };
    }
    return {
      ok: true,
      kind: status.vcs,
      content: res.stdout,
      tracked: true,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeRel(root: string, absPath: string): string | null {
  const rootN = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = absPath.replace(/\\/g, "/");
  if (!abs.startsWith(`${rootN}/`)) return null;
  return abs.slice(rootN.length + 1);
}

function parseToDiff(stdout: string): VcsFileDiff {
  const { lines, deleted } = parseUnifiedDiff(stdout);
  return { allAdded: false, lines, deleted };
}

// ------------------------------------------------ commit watch (.git/.svn)

const VCS_WATCH_DEBOUNCE_MS = 400;
/**
 * After firing, metadata writes are swallowed for a window: `git status`
 * itself refreshes `.git/index`, which would otherwise re-trigger a loop
 * (watch → invalidate → status → index write → watch …).
 */
const VCS_WATCH_QUIET_MS = 3000;

type VcsWatchEntry = {
  watchers: FSWatcher[];
  timer: NodeJS.Timeout | null;
  quietUntil: number;
  schedule: () => void;
};

const vcsWatches = new Map<string, VcsWatchEntry>();
let vcsTreeChangedSink: ((root: string) => void) | null = null;

/** Drop the cached status for `root` (commit / checkout / branch switch …). */
export function invalidateVcsStatusCache(root: string): void {
  const slot = cache.get(resolve(root));
  if (!slot) return;
  slot.result = null;
  slot.at = 0;
}

function fireVcsTreeChanged(root: string): void {
  invalidateVcsStatusCache(root);
  vcsTreeChangedSink?.(root);
}

/** `.git` dir at the REPO root (workspace may be a subdir); pointer-aware. */
async function gitMetaDir(root: string): Promise<string | null> {
  try {
    const toplevel = await run(root, ["git", "rev-parse", "--show-toplevel"]);
    if (toplevel.code !== 0) return null;
    const base = toplevel.stdout.trim();
    const dotGit = join(base, ".git");
    const info = await stat(dotGit);
    if (info.isDirectory()) return dotGit;
    if (info.isFile()) {
      // Worktree/submodule: ".git" is a pointer file — "gitdir: <path>".
      const text = await readFile(dotGit, "utf8");
      const m = text.match(/^gitdir:\s*(.+)\s*$/m);
      if (m) return resolve(base, m[1]!.trim());
    }
  } catch {
    // git missing or not a repo — svn fallback below
  }
  return null;
}

async function attachVcsMetaWatchers(
  root: string,
  entry: VcsWatchEntry,
): Promise<void> {
  const targets: string[] = [];
  const dotGit = await gitMetaDir(root);
  if (dotGit) targets.push(dotGit);
  targets.push(join(root, ".svn"));
  for (const dir of targets) {
    try {
      // recursive is native on macOS/Windows (refs/heads/… is nested);
      // Linux throws → caught: badges still refresh via the other triggers.
      entry.watchers.push(
        watch(dir, { recursive: true, persistent: false }, () =>
          entry.schedule(),
        ),
      );
    } catch {
      // no .git/.svn here (or unsupported) — nothing to watch
    }
  }
}

/**
 * Watch VCS metadata (.git / .svn) for one workspace root. A commit only
 * touches those and the Dev Mode fs watcher ignores dot-dirs, so this is
 * the only reliable "VCS state changed" signal for agent/external commits.
 */
export function startVcsChangeWatch(
  root: string,
  onFire: (root: string) => void,
): void {
  vcsTreeChangedSink = onFire;
  const key = resolve(root);
  if (vcsWatches.has(key)) return;
  const entry: VcsWatchEntry = {
    watchers: [],
    timer: null,
    quietUntil: 0,
    schedule: () => {
      if (Date.now() < entry.quietUntil) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.quietUntil = Date.now() + VCS_WATCH_QUIET_MS;
        fireVcsTreeChanged(key);
      }, VCS_WATCH_DEBOUNCE_MS);
    },
  };
  vcsWatches.set(key, entry);
  void attachVcsMetaWatchers(key, entry);
}

export function stopVcsChangeWatch(root: string): void {
  const key = resolve(root);
  const entry = vcsWatches.get(key);
  if (!entry) return;
  vcsWatches.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  for (const w of entry.watchers) {
    try {
      w.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Run one VCS action inside `root`. Paths are workspace-relative and passed
 * as argv (never through a shell). `svn-update` is the only op that may
 * touch the network.
 */
export async function runVcsAction(
  root: string,
  action: VcsAction,
): Promise<{ ok: boolean; message?: string }> {
  // svn-update authenticates against the repo server — route it through
  // the auth-aware executor (ask + save + retry) instead of raw argv.
  if (action.kind === "svn-update") {
    try {
      const { execSvnWithAuth } = await import("../svn/execSvn.js");
      const { parseSvnUpdateSummary } = await import("../svn/parseSvn.js");
      const { stdout } = await execSvnWithAuth(
        root,
        ["update", "--", ...action.paths],
        { operation: "Update" },
      );
      // Update can rewrite tracked files — let open editors/gutters refresh.
      fireVcsTreeChanged(root);
      const summary = parseSvnUpdateSummary(stdout);
      return { ok: true, message: summary.text };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  let args: string[];
  switch (action.kind) {
    case "git-stage":
      args = ["git", "add", "--", ...action.paths];
      break;
    case "git-unstage":
      args = ["git", "restore", "--staged", "--", ...action.paths];
      break;
    case "git-discard":
      args = ["git", "restore", "--", ...action.paths];
      break;
    case "svn-revert":
      args = ["svn", "revert", "--depth", "empty", "--", ...action.paths];
      break;
  }
  try {
    const res = await run(root, args);
    if (res.code !== 0) {
      return {
        ok: false,
        message: (res.stderr || res.stdout).trim() || `${action.kind} failed`,
      };
    }
    // Action changed the tree — drop cache so the next status is fresh.
    const slot = slotOf(root);
    slot.at = 0;
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerVcsIpc(opts?: {
  /** Broadcast sink for VCS metadata changes (commit / branch switch). */
  onTreeChanged?: (root: string) => void;
}): void {
  vcsTreeChangedSink = opts?.onTreeChanged ?? null;

  ipcMain.handle("vcs:status", (_event, root: string) =>
    getVcsStatus(String(root)),
  );

  ipcMain.handle(
    "vcs:fileDiff",
    (_event, root: string, absPath: string) =>
      getVcsFileDiff(String(root), String(absPath)),
  );

  ipcMain.handle(
    "vcs:fileBase",
    (_event, root: string, absPath: string) =>
      getVcsFileBase(String(root), String(absPath)),
  );

  ipcMain.handle(
    "vcs:blame",
    (_event, root: string, absPath: string) =>
      getVcsBlame(String(root), String(absPath)),
  );

  ipcMain.handle("vcs:action", (_event, root: string, action: VcsAction) =>
    runVcsAction(String(root), action),
  );

  ipcMain.handle("vcs:reveal", (_event, path: string) => {
    // File → selects it in Finder/Explorer; directory → opens the folder.
    shell.showItemInFolder(String(path));
    return { ok: true };
  });
}
