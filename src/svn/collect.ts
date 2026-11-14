import { stat } from "node:fs/promises";
import { join } from "node:path";
import { execSvn } from "./execSvn.js";
import {
  parseSvnDiffCounts,
  parseSvnStatus,
  type SvnStatusKind,
} from "./parseSvn.js";
import { countLinesIn, countTextLines, listFilesUnder } from "./readText.js";
import {
  claimScanBudget,
  createScanBudget,
  type ScanBudget,
} from "../vcs/readCapped.js";
import type { WorkingTreeChangeStatus } from "../git/types.js";

export type SvnCollectedChange = {
  /** WC-root-relative posix path (matches git's repo-root-relative paths). */
  path: string;
  kind: SvnStatusKind;
  status: WorkingTreeChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
};

export type SvnCollectedResult = {
  /** WC root directory every path is relative to. */
  root: string;
  changes: SvnCollectedChange[];
};

function statusFromKind(kind: SvnStatusKind): WorkingTreeChangeStatus {
  switch (kind) {
    case "modified":
    case "replaced":
    case "conflicted":
      return "modified";
    case "added":
      return "added";
    case "deleted":
    case "missing":
      return "deleted";
    case "untracked":
      return "untracked";
    default:
      return "modified";
  }
}

export async function isSvnWorkingCopy(cwd: string): Promise<boolean> {
  try {
    await execSvn(cwd, ["info"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the WC root. Prefers `--show-item wc-root` (SVN 1.9+), falls back
 * to parsing `svn info` text. Returns null when cwd is not inside a WC.
 */
export async function resolveSvnWcRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execSvn(cwd, ["info", "--show-item", "wc-root"]);
    const root = stdout.trim();
    if (root) return root;
  } catch {
    // Older client or not a WC — try the text parse below.
  }
  try {
    const { stdout } = await execSvn(cwd, ["info"]);
    for (const line of stdout.split("\n")) {
      const match = line.match(/^Working Copy Root Path:\s*(.+)$/);
      if (match?.[1]) return match[1].trim();
    }
  } catch {
    return null;
  }
  return null;
}

async function diffCountsAtRoot(
  root: string,
  pathArg?: string,
): Promise<Map<string, { insertions: number; deletions: number; binary: boolean; hasContent: boolean }>> {
  const args = pathArg ? ["diff", "--", pathArg] : ["diff"];
  const { stdout } = await execSvn(root, args);
  return parseSvnDiffCounts(stdout);
}

/** Line count for unversioned / scheduled-add files, expanding directories. */
async function countAddedLike(
  root: string,
  relPath: string,
  budget: ScanBudget,
): Promise<{ insertions: number; binary: boolean; fileCount: number }> {
  const abs = join(root, relPath);
  let binary = false;
  let insertions = 0;
  let fileCount = 0;

  const countFile = async (fileAbs: string): Promise<void> => {
    fileCount += 1;
    const lines = await countTextLines(fileAbs);
    if (lines == null) {
      binary = true;
      insertions += 1;
      return;
    }
    insertions += lines;
  };

  let info;
  try {
    info = await stat(abs);
  } catch {
    info = null;
  }

  if (info?.isDirectory()) {
    for (const file of await listFilesUnder(abs)) {
      if (!claimScanBudget(budget, file.size)) {
        // Out of scan budget: the badge stays approximate rather than opening
        // thousands more files.
        fileCount += 1;
        insertions += 1;
        continue;
      }
      await countFile(file.abs);
    }
  } else if (claimScanBudget(budget, info?.size ?? 0)) {
    await countFile(abs);
  } else {
    fileCount += 1;
    insertions += 1;
  }

  return { insertions, binary, fileCount: Math.max(fileCount, 1) };
}

/** Base text line count for a missing (`!`) path — deletions via `svn cat`. */
async function countBaseLines(
  root: string,
  relPath: string,
): Promise<number | null> {
  try {
    const { stdout } = await execSvn(root, ["cat", "-r", "BASE", "--", relPath], {
      maxBuffer: 512 * 1024 + 64 * 1024,
    });
    if (stdout.includes("\0")) return null;
    return Math.max(countLinesIn(stdout), 1);
  } catch {
    return null;
  }
}

/**
 * Single source of truth for SVN working-copy changes. Mirrors git behavior:
 * repo-wide view from the WC root, props-only entries invisible, untracked /
 * added files counted by disk content, missing files counted as base deletions.
 * Returns null when cwd is not an SVN working copy (or `svn` is unavailable).
 */
export async function collectSvnChanges(
  cwd: string,
): Promise<SvnCollectedResult | null> {
  const root = await resolveSvnWcRoot(cwd);
  if (!root) return null;

  let statusStdout: string;
  try {
    const { stdout } = await execSvn(root, ["status"]);
    statusStdout = stdout;
  } catch {
    return null;
  }

  const entries = parseSvnStatus(statusStdout).filter(
    (entry) => entry.kind !== "obscured",
  );
  if (entries.length === 0) {
    return { root, changes: [] };
  }

  const diffCounts = await diffCountsAtRoot(root).catch(
    () => new Map<string, { insertions: number; deletions: number; binary: boolean; hasContent: boolean }>(),
  );

  const changes: SvnCollectedChange[] = [];
  // One budget for the whole scan — a single huge unversioned tree must not
  // starve the entries after it, and the total stays bounded either way.
  const budget = createScanBudget();
  for (const entry of entries) {
    if (entry.kind === "untracked" || entry.kind === "added") {
      const counted = await countAddedLike(root, entry.path, budget);
      changes.push({
        path: entry.path,
        kind: entry.kind,
        status: statusFromKind(entry.kind),
        insertions: counted.insertions,
        deletions: 0,
        binary: counted.binary,
      });
      continue;
    }

    const counts = diffCounts.get(entry.path);
    if (counts && counts.hasContent && (counts.insertions > 0 || counts.deletions > 0)) {
      changes.push({
        path: entry.path,
        kind: entry.kind,
        status: statusFromKind(entry.kind),
        insertions: counts.insertions,
        deletions: counts.deletions,
        binary: counts.binary,
      });
      continue;
    }

    if (counts?.binary) {
      changes.push({
        path: entry.path,
        kind: entry.kind,
        status: statusFromKind(entry.kind),
        insertions: 1,
        deletions: 0,
        binary: true,
      });
      continue;
    }

    if (entry.kind === "missing") {
      const baseLines = await countBaseLines(root, entry.path);
      changes.push({
        path: entry.path,
        kind: entry.kind,
        status: "deleted",
        insertions: 0,
        deletions: baseLines ?? 1,
        binary: baseLines == null,
      });
      continue;
    }

    // Props-only modification (or conflicted without content) — keep it
    // visible in the list with 0/0 like git mode-only changes.
    changes.push({
      path: entry.path,
      kind: entry.kind,
      status: statusFromKind(entry.kind),
      insertions: 0,
      deletions: 0,
      binary: false,
    });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { root, changes };
}
