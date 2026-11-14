import { execSvn } from "./execSvn.js";
import {
  collectSvnChanges,

} from "./collect.js";
import { parseSvnStatus } from "./parseSvn.js";
import type { CommitContext, WorkingTreeStats } from "../git/types.js";

/** Soft cap for LLM commit context (~80k chars) — matches git layer. */
export const SVN_COMMIT_CONTEXT_SOFT_CAP = 80_000;

const CLEAN_STATS: WorkingTreeStats = {
  isRepo: true,
  insertions: 0,
  deletions: 0,
  dirtyFileCount: 0,
  // SVN has no local-commit/push split — always 0.
  aheadCount: 0,
  behindCount: 0,
};

const HIDDEN_STATS: WorkingTreeStats = {
  isRepo: false,
  insertions: 0,
  deletions: 0,
  dirtyFileCount: 0,
  aheadCount: 0,
  behindCount: 0,
};

/**
 * Summarize SVN working-copy changes for the footer bar. Same contract as
 * git's getWorkingTreeStats: props-only dirt is invisible, clean trees never
 * report changes.
 */
export async function getSvnWorkingTreeStats(
  cwd: string,
): Promise<WorkingTreeStats> {
  const collected = await collectSvnChanges(cwd);
  if (!collected) {
    return { ...HIDDEN_STATS };
  }

  let insertions = 0;
  let deletions = 0;
  let dirtyFileCount = 0;
  for (const change of collected.changes) {
    insertions += change.insertions;
    deletions += change.deletions;
    dirtyFileCount += 1;
  }

  if (insertions === 0 && deletions === 0) {
    return { ...CLEAN_STATS };
  }

  return {
    isRepo: true,
    insertions,
    deletions,
    dirtyFileCount: Math.max(dirtyFileCount, 1),
    aheadCount: 0,
    behindCount: 0,
  };
}

function clipContext(parts: string[], softCap: number): string {
  const joined = parts.filter((p) => p.trim().length > 0).join("\n\n");
  if (joined.length <= softCap) return joined;
  return `${joined.slice(0, softCap)}\n\n…[truncated]`;
}

/**
 * Collect truncated status + diff for LLM commit-message generation.
 * `paths` (relative to `cwd`) narrows it to the Dev Mode tree's selection.
 */
export async function collectSvnCommitContext(
  cwd: string,
  paths?: string[],
): Promise<CommitContext | null> {
  const scope = (paths ?? []).filter((path) => path.trim().length > 0);
  if (scope.length > 0) {
    return collectScopedSvnCommitContext(cwd, scope);
  }

  const stats = await getSvnWorkingTreeStats(cwd);
  if (!stats.isRepo || stats.dirtyFileCount === 0) {
    return null;
  }

  const collected = await collectSvnChanges(cwd);
  if (!collected) return null;

  let status = "";
  let diff = "";
  try {
    const statusResult = await execSvn(collected.root, ["status"]);
    status = statusResult.stdout;
  } catch {
    status = "";
  }
  try {
    const diffResult = await execSvn(collected.root, ["diff"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    diff = diffResult.stdout;
  } catch {
    diff = "";
  }

  const body = clipContext(
    [
      "(Subversion working copy — the same commit-message conventions apply.)",
      "## svn status",
      status.trim() || "(no status output)",
      "## svn diff",
      diff.trim() || "(no tracked diff — see ? entries in status)",
    ],
    SVN_COMMIT_CONTEXT_SOFT_CAP,
  );

  return {
    status: body,
    diff: "",
    dirtyFileCount: stats.dirtyFileCount,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

/**
 * Pathspec-scoped variant. Stats come from the scoped output rather than the
 * whole working copy — they drive the fallback message ("Update N files"), so
 * a one-file commit must not claim the working copy's full count.
 */
async function collectScopedSvnCommitContext(
  cwd: string,
  scope: string[],
): Promise<CommitContext | null> {
  let status = "";
  let diff = "";
  try {
    const result = await execSvn(cwd, ["status", "--", ...scope]);
    status = result.stdout;
  } catch {
    return null;
  }
  try {
    const result = await execSvn(cwd, ["diff", "--", ...scope], {
      maxBuffer: 32 * 1024 * 1024,
    });
    diff = result.stdout;
  } catch {
    diff = "";
  }

  const entries = parseSvnStatus(status).filter(
    (entry) => entry.kind !== "obscured",
  );
  if (entries.length === 0 && !diff.trim()) return null;

  let insertions = 0;
  let deletions = 0;
  for (const rawLine of diff.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  const body = clipContext(
    [
      "(Subversion working copy — the same commit-message conventions apply.)",
      "(Only the paths being committed are shown.)",
      "## svn status",
      status.trim() || "(no status output)",
      "## svn diff",
      diff.trim() || "(no tracked diff — see ? entries in status)",
    ],
    SVN_COMMIT_CONTEXT_SOFT_CAP,
  );

  return {
    status: body,
    diff: "",
    dirtyFileCount: Math.max(entries.length, 1),
    insertions,
    deletions,
  };
}
