import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

const DETECT_TTL_MS = 3_000;

type DetectCacheEntry = { kind: VcsKind | null; expires: number };
const detectCache = new Map<string, DetectCacheEntry>();

export async function detectVcs(cwd: string): Promise<VcsKind | null> {
  const key = cwd;
  const now = Date.now();
  const cached = detectCache.get(key);
  if (cached && cached.expires > now) {
    return cached.kind;
  }

  let kind: VcsKind | null = null;
  // In mixed projects a nested SVN working copy can live inside a Git tree
  // (or vice versa). The nearest metadata owns the paths being committed.
  let directory = resolve(cwd);
  while (true) {
    const markers = await Promise.all([".git", ".svn"].map(name => lstat(join(directory, name)).then(() => true, () => false)));
    if (markers[0] || markers[1]) { kind = markers[0] ? "git" : "svn"; break; }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!kind) {
    if (await isGitRepo(cwd)) kind = "git";
    else if (await isSvnWorkingCopy(cwd)) kind = "svn";
  }
  detectCache.set(key, { kind, expires: now + DETECT_TTL_MS });
  return kind;
}

const statsInFlight = new Map<string, Promise<WorkingTreeStats>>();

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

export async function listWorkingTreeChanges(
  cwd: string,
): Promise<WorkingTreeChangesResult> {
  if ((await detectVcs(cwd)) === "svn") {
    return listSvnWorkingTreeChanges(cwd);
  }
  return listGitWorkingTreeChanges(cwd);
}

export async function getWorkingTreePathDiff(
  cwd: string,
  relativePath: string,
): Promise<WorkingTreePathDiff> {
  if ((await detectVcs(cwd)) === "svn") {
    return getSvnWorkingTreePathDiff(cwd, relativePath);
  }
  return getGitWorkingTreePathDiff(cwd, relativePath);
}

export async function collectCommitContext(
  cwd: string,
  paths?: string[],
): Promise<CommitContext | null> {
  if ((await detectVcs(cwd)) === "svn") {
    return collectSvnCommitContext(cwd, paths);
  }
  return collectGitCommitContext(cwd, paths);
}

export type CreatedAnyVcsCommit = {
  hash: string;
  shortHash: string;
  message: string;
  subject: string;
  vcs: "git" | "svn";
};

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
