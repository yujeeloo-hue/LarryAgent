import { stat } from "node:fs/promises";
import { join } from "node:path";
import { execGit } from "./execGit.js";
import {
  claimScanBudget,
  countTextLines,
  createScanBudget,
  type ScanBudget,
} from "../vcs/readCapped.js";
import type { CommitContext, WorkingTreeStats } from "./types.js";

/** Well-known SHA-1 empty tree OID (no commits yet). */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d6927bbc6c6eb";

/** Soft cap for LLM commit context (~80k chars). */
export const COMMIT_CONTEXT_SOFT_CAP = 80_000;

const CLEAN_STATS: WorkingTreeStats = {
  isRepo: true,
  insertions: 0,
  deletions: 0,
  dirtyFileCount: 0,
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

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execGit(cwd, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function resolveDiffBase(cwd: string): Promise<string> {
  try {
    await execGit(cwd, ["rev-parse", "--verify", "HEAD"]);
    return "HEAD";
  } catch {
    return EMPTY_TREE_OID;
  }
}

/**
 * Commits on HEAD missing from the upstream branch — drives the footer
 * Push button. Any failure (no upstream, offline, shallow) reads as 0 so
 * Push simply stays hidden instead of erroring the stats bar.
 */
async function countUnpushedCommits(cwd: string): Promise<number> {
  try {
    const { stdout } = await execGit(cwd, [
      "rev-list",
      "--count",
      "@{upstream}..HEAD",
    ]);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/**
 * Commits on the upstream branch missing from HEAD — informational only
 * (reflects the last fetch; Pull refreshes it). Any failure (no upstream,
 * offline, shallow) reads as 0.
 */
async function countBehindCommits(cwd: string): Promise<number> {
  try {
    const { stdout } = await execGit(cwd, [
      "rev-list",
      "--count",
      "HEAD..@{upstream}",
    ]);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** Commits on @{upstream} missing from HEAD. 0 when not a repo or no upstream. */
export async function getGitBehindCount(cwd: string): Promise<number> {
  if (!(await isGitRepo(cwd))) return 0;
  return countBehindCommits(cwd);
}

function parseNumstatLine(line: string): {
  insertions: number;
  deletions: number;
  path: string;
  binary: boolean;
} | null {
  const trimmed = line.trimEnd();
  if (!trimmed) return null;
  const tab1 = trimmed.indexOf("\t");
  const tab2 = trimmed.indexOf("\t", tab1 + 1);
  if (tab1 < 0 || tab2 < 0) return null;
  const addedRaw = trimmed.slice(0, tab1);
  const deletedRaw = trimmed.slice(tab1 + 1, tab2);
  const path = trimmed.slice(tab2 + 1).split("\t")[0] ?? "";
  if (!path) return null;
  // Binary files show "-" for both columns — count as one insertion for UI.
  if (addedRaw === "-" || deletedRaw === "-") {
    return { insertions: 1, deletions: 0, path, binary: true };
  }
  const insertions = Number(addedRaw);
  const deletions = Number(deletedRaw);
  if (!Number.isFinite(insertions) || !Number.isFinite(deletions)) {
    return { insertions: 1, deletions: 0, path, binary: true };
  }
  return { insertions, deletions, path, binary: false };
}

async function countUntrackedLines(
  cwd: string,
  relativePath: string,
  budget: ScanBudget,
): Promise<number> {
  const abs = join(cwd, relativePath);
  let size = 0;
  try {
    size = (await stat(abs)).size;
  } catch {
    // Unreadable path still counts as a change.
    return 1;
  }
  // Out of scan budget: keep the badge approximate rather than opening the
  // rest of a working tree full of untracked files.
  if (!claimScanBudget(budget, size)) return 1;
  return (await countTextLines(abs)) ?? 1;
}

/**
 * Summarize working-tree changes vs HEAD (or empty tree when no commits).
 * Dirty detection is driven by `git status --porcelain` so a clean tree
 * never reports changes. Untracked files (respecting ignore) count as insertions.
 */
export async function getWorkingTreeStats(
  cwd: string,
): Promise<WorkingTreeStats> {
  if (!(await isGitRepo(cwd))) {
    return { ...HIDDEN_STATS };
  }
  // Computed up front: a clean tree after a commit is exactly when the
  // ahead count matters most (Commit hides, Push must stay).
  const aheadCount = await countUnpushedCommits(cwd);
  const behindCount = await countBehindCommits(cwd);

  try {
    const { stdout: porcelain } = await execGit(cwd, [
      "status",
      "--porcelain",
      "-uall",
    ]);
    const statusLines = porcelain
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    // Authoritative clean check — never show Commit when status is empty.
    if (statusLines.length === 0) {
      return { ...CLEAN_STATS, aheadCount, behindCount };
    }

    const base = await resolveDiffBase(cwd);
    const { stdout: numstatOut } = await execGit(cwd, [
      "diff",
      "--numstat",
      base,
    ]);

    let insertions = 0;
    let deletions = 0;
    const dirtyPaths = new Set<string>();

    for (const line of numstatOut.split("\n")) {
      const parsed = parseNumstatLine(line);
      if (!parsed) continue;
      // Skip pure metadata / empty diffs (e.g. mode-only 0/0).
      if (parsed.insertions === 0 && parsed.deletions === 0) continue;
      insertions += parsed.insertions;
      deletions += parsed.deletions;
      dirtyPaths.add(parsed.path);
    }

    const { stdout: untrackedOut } = await execGit(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    const budget = createScanBudget();
    for (const raw of untrackedOut.split("\n")) {
      const path = raw.trim();
      if (!path) continue;
      const lines = await countUntrackedLines(cwd, path, budget);
      if (lines <= 0) continue;
      dirtyPaths.add(path);
      insertions += lines;
    }

    // If status reported dirty but there are no countable line changes
    // (mode-only, empty, etc.), treat as clean for the Commit button.
    if (insertions === 0 && deletions === 0) {
      return { ...CLEAN_STATS, aheadCount, behindCount };
    }

    return {
      isRepo: true,
      insertions,
      deletions,
      dirtyFileCount: Math.max(dirtyPaths.size, 1),
      aheadCount,
      behindCount,
    };
  } catch {
    return { ...HIDDEN_STATS };
  }
}

function clipContext(parts: string[], softCap: number): string {
  const joined = parts.filter((p) => p.trim().length > 0).join("\n\n");
  if (joined.length <= softCap) return joined;
  return `${joined.slice(0, softCap)}\n\n…[truncated]`;
}

/**
 * Collect truncated status + diff for LLM commit-message generation.
 * `paths` (workspace-relative) narrows every git call to that pathspec so a
 * per-file commit gets a message about that file only.
 */
export async function collectCommitContext(
  cwd: string,
  paths?: string[],
): Promise<CommitContext | null> {
  if (!(await isGitRepo(cwd))) return null;

  const scope = (paths ?? []).filter((path) => path.trim().length > 0);
  const pathspec = scope.length > 0 ? ["--", ...scope] : [];

  const stats = await getWorkingTreeStats(cwd);
  if (stats.dirtyFileCount === 0) {
    return null;
  }

  const base = await resolveDiffBase(cwd);
  let status = "";
  let diff = "";
  try {
    const statusResult = await execGit(cwd, [
      "status",
      "--porcelain",
      ...pathspec,
    ]);
    status = statusResult.stdout;
  } catch {
    status = "";
  }
  try {
    const diffResult = await execGit(cwd, ["diff", base, ...pathspec], {
      maxBuffer: 32 * 1024 * 1024,
    });
    diff = diffResult.stdout;
  } catch {
    diff = "";
  }

  // Include a short untracked listing so the model sees new files.
  let untrackedNote = "";
  try {
    const { stdout } = await execGit(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      ...pathspec,
    ]);
    const paths = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (paths.length > 0) {
      untrackedNote = [
        "## Untracked files",
        ...paths.slice(0, 200).map((p) => `?? ${p}`),
        paths.length > 200 ? `…and ${paths.length - 200} more` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    untrackedNote = "";
  }

  const body = clipContext(
    [
      "## git status --porcelain",
      status.trim() || "(clean porcelain; see untracked/diff)",
      untrackedNote,
      `## git diff ${base}`,
      diff.trim() || "(no tracked diff)",
    ],
    COMMIT_CONTEXT_SOFT_CAP,
  );

  if (scope.length === 0) {
    return {
      status: body,
      diff: "",
      dirtyFileCount: stats.dirtyFileCount,
      insertions: stats.insertions,
      deletions: stats.deletions,
    };
  }

  // Scoped commit: workspace-wide stats would claim far more files than the
  // pathspec touches, and they drive the fallback message ("Update N files").
  const scopedCounts = countDiffLines(diff);
  const scopedFiles = status
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
  return {
    status: body,
    diff: "",
    dirtyFileCount: Math.max(scopedFiles, 1),
    insertions: scopedCounts.insertions,
    deletions: scopedCounts.deletions,
  };
}

/** Insertions / deletions from a unified diff body (file headers excluded). */
function countDiffLines(diff: string): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { insertions, deletions };
}

export function fallbackCommitMessage(stats: WorkingTreeStats): string {
  const n = stats.dirtyFileCount;
  if (n <= 0) return "Update files";
  if (n === 1) return "Update 1 file";
  return `Update ${n} files`;
}
