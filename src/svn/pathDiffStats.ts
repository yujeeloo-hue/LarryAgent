import { dirname, relative, resolve, sep } from "node:path";
import { execSvn } from "./execSvn.js";
import { resolveSvnWcRoot } from "./collect.js";
import { parseSvnDiffCounts, parseSvnStatus } from "./parseSvn.js";
import { countTextLines } from "./readText.js";
import type { PathDiffStats } from "../git/types.js";

function toPosixRelative(absPath: string, root: string): string | null {
  const rel = relative(root, absPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join("/");
}

/**
 * Per-path WC line stats for a single SVN path (mirror of the git version).
 * Unversioned / scheduled-add paths count whole-file lines as insertions.
 */
async function statsForAbsPath(
  absPath: string,
): Promise<Omit<PathDiffStats, "path">> {
  const root = await resolveSvnWcRoot(dirname(absPath));
  if (!root) {
    return { isRepo: false, insertions: 0, deletions: 0, hasDiff: false };
  }

  const rel = toPosixRelative(absPath, root);
  if (!rel) {
    return { isRepo: false, insertions: 0, deletions: 0, hasDiff: false };
  }

  // Unversioned (?) or scheduled-add (A): whole-file insertions from disk.
  try {
    const { stdout } = await execSvn(root, ["status", "--", rel]);
    const entries = parseSvnStatus(stdout);
    const addedLike = entries.some(
      (entry) => entry.kind === "untracked" || entry.kind === "added",
    );
    if (addedLike) {
      const lines = await countTextLines(absPath);
      if (lines == null) {
        return { isRepo: true, insertions: 0, deletions: 0, hasDiff: false };
      }
      return {
        isRepo: true,
        insertions: Math.max(lines, 1),
        deletions: 0,
        hasDiff: true,
      };
    }
  } catch {
    // Fall through to diff counting.
  }

  try {
    const { stdout } = await execSvn(root, ["diff", "--", rel]);
    const counts = parseSvnDiffCounts(stdout).get(rel);
    if (!counts) {
      return { isRepo: true, insertions: 0, deletions: 0, hasDiff: false };
    }
    if (counts.binary || !counts.hasContent) {
      return { isRepo: true, insertions: 0, deletions: 0, hasDiff: false };
    }
    if (counts.insertions === 0 && counts.deletions === 0) {
      return { isRepo: true, insertions: 0, deletions: 0, hasDiff: false };
    }
    return {
      isRepo: true,
      insertions: counts.insertions,
      deletions: counts.deletions,
      hasDiff: true,
    };
  } catch {
    return { isRepo: true, insertions: 0, deletions: 0, hasDiff: false };
  }
}

/**
 * Per-path working-tree line stats for conversation File outputs, SVN side.
 * Binary / props-only paths report `hasDiff: false` (UI hides +/-).
 */
export async function getSvnPathsDiffStats(
  absolutePaths: string[],
): Promise<PathDiffStats[]> {
  const out: PathDiffStats[] = [];
  for (const original of absolutePaths) {
    const abs = resolve(original);
    const stats = await statsForAbsPath(abs).catch(() => ({
      isRepo: false,
      insertions: 0,
      deletions: 0,
      hasDiff: false,
    }));
    out.push({ path: original, ...stats });
  }
  return out;
}
