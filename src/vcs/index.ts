import {
  collectCommitContext as collectGitCommitContext,
  commitPaths as commitPathsGit,
  getPathsDiffStats as getGitPathsDiffStats,
  getWorkingTreePathDiff as getGitWorkingTreePathDiff,
  getWorkingTreeStats as getGitWorkingTreeStats,
  isGitRepo,
  listWorkingTreeChanges as listGitWorkingTreeChanges,
  type CommitContext,
  type PathDiffStats,
  type WorkingTreeChangesResult,
  type WorkingTreePathDiff,
  type WorkingTreeStats,
} from "../git/index.js";
import {
  collectSvnCommitContext,
  getSvnPathsDiffStats,
  getSvnWorkingTreePathDiff,
  getSvnWorkingTreeStats,
  isSvnWorkingCopy,
  listSvnWorkingTreeChanges,
  svnCommitAll,
  svnCommitPaths,
} from "../svn/index.js";

export type VcsKind = "git" | "svn";

/**
 * Detection TTL — the footer bar refreshes stats after every tool call, and
 * probing `git rev-parse` + `svn info` each time is wasteful. Short enough
 * that `git init` / `svn checkout` in a session is picked up promptly.
 */
const DETECT_TTL_MS = 3_000;

type DetectCacheEntry = { kind: VcsKind | null; expires: number };
const detectCache = new Map<string, DetectCacheEntry>();

/** Git wins when a directory is both a git repo and an SVN working copy. */
export async function detectVcs(cwd: string): Promise<VcsKind | null> {
  const key = cwd;
  const now = Date.now();
  const cached = detectCache.get(key);
  if (cached && cached.expires > now) {
    return cached.kind;
  }

  let kind: VcsKind | null = null;
  if (await isGitRepo(cwd)) {
    kind = "git";
  } else if (await isSvnWorkingCopy(cwd)) {
    kind = "svn";
  }
  detectCache.set(key, { kind, expires: now + DETECT_TTL_MS });
  return kind;
}

/**
 * One scan per workspace at a time. A full working-tree scan spawns VCS
 * subprocesses and walks unversioned trees — seconds on a large checkout — and
 * several UI paths request it off the same session update. Without this,
 * callers stack scans until they starve each other; sharing the in-flight
 * promise makes concurrent requests free.
 */
const statsInFlight = new Map<string, Promise<WorkingTreeStats>>();

/** Working-tree line summary for the footer Commit button. */
export function getWorkingTreeStats(cwd: string): Promise<WorkingTreeStats> {
  const running = statsInFlight.get(cwd);
  if (running) return running;

  const scan = (async () => {
    if ((await detectVcs(cwd)) === "svn") {
      return getSvnWorkingTreeStats(cwd);
    }
    return getGitWorkingTreeStats(cwd);
  })().finally(() => {
    statsInFlight.delete(cwd);
  });

  statsInFlight.set(cwd, scan);
  return scan;
}

/** Dirty file list for the Changes window. */
export async function listWorkingTreeChanges(
  cwd: string,
): Promise<WorkingTreeChangesResult> {
  if ((await detectVcs(cwd)) === "svn") {
    return listSvnWorkingTreeChanges(cwd);
  }
  return listGitWorkingTreeChanges(cwd);
}

/** Before/after text for the lined diff preview. */
export async function getWorkingTreePathDiff(
  cwd: string,
  relativePath: string,
): Promise<WorkingTreePathDiff> {
  if ((await detectVcs(cwd)) === "svn") {
    return getSvnWorkingTreePathDiff(cwd, relativePath);
  }
  return getGitWorkingTreePathDiff(cwd, relativePath);
}

/**
 * Commit context for LLM message generation. `paths` (workspace-relative)
 * narrows the draft to those files.
 */
export async function collectCommitContext(
  cwd: string,
  paths?: string[],
): Promise<CommitContext | null> {
  if ((await detectVcs(cwd)) === "svn") {
    return collectSvnCommitContext(cwd, paths);
  }
  return collectGitCommitContext(cwd, paths);
}

/** Commit outcome shape shared by the git and svn implementations. */
export type CreatedAnyVcsCommit = {
  hash: string;
  shortHash: string;
  message: string;
  subject: string;
  vcs: "git" | "svn";
};

/**
 * Commit only `paths` (workspace-relative), or everything when omitted.
 * Scoped commits are git-only — SVN working copies always commit in full.
 */
export async function commitPaths(
  cwd: string,
  message: string,
  paths?: string[],
): Promise<CreatedAnyVcsCommit> {
  if ((await detectVcs(cwd)) === "svn") {
    return paths && paths.length > 0
      ? svnCommitPaths(cwd, message, paths)
      : svnCommitAll(cwd, message);
  }
  return commitPathsGit(cwd, message, paths);
}

/**
 * Per-path stats for conversation File cards. Git handles what it can;
 * leftovers (not inside any git repo) get an SVN attempt so both VCS types
 * show +/- counts in mixed environments.
 */
export async function getPathsDiffStats(
  absolutePaths: string[],
): Promise<PathDiffStats[]> {
  if (absolutePaths.length === 0) return [];

  const gitRows = await getGitPathsDiffStats(absolutePaths);
  const svnIndexes = gitRows
    .map((row, index) => (row.isRepo ? -1 : index))
    .filter((index) => index >= 0);
  if (svnIndexes.length === 0) {
    return gitRows;
  }

  const svnRows = await getSvnPathsDiffStats(
    svnIndexes.map((index) => absolutePaths[index]!),
  );
  const out = [...gitRows];
  svnIndexes.forEach((originalIndex, i) => {
    out[originalIndex] = svnRows[i] ?? gitRows[originalIndex]!;
  });
  return out;
}
