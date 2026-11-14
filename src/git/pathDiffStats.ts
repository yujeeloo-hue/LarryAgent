import { dirname, relative, resolve, sep } from "node:path";
import { execGit } from "./execGit.js";
import { countTextLines } from "../vcs/readCapped.js";
import type { PathDiffStats } from "./types.js";

export type { PathDiffStats } from "./types.js";

const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d6927bbc6c6eb";

async function resolveGitRoot(startDir: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(startDir, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const root = stdout.trim();
    return root || null;
  } catch {
    return null;
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

function parseNumstatLine(line: string): {
  insertions: number;
  deletions: number;
  binary: boolean;
} | null {
  const trimmed = line.trimEnd();
  if (!trimmed) return null;
  const tab1 = trimmed.indexOf("\t");
  const tab2 = trimmed.indexOf("\t", tab1 + 1);
  if (tab1 < 0 || tab2 < 0) return null;
  const addedRaw = trimmed.slice(0, tab1);
  const deletedRaw = trimmed.slice(tab1 + 1, tab2);
  if (addedRaw === "-" || deletedRaw === "-") {
    return { insertions: 1, deletions: 0, binary: true };
  }
  const insertions = Number(addedRaw);
  const deletions = Number(deletedRaw);
  if (!Number.isFinite(insertions) || !Number.isFinite(deletions)) {
    return { insertions: 1, deletions: 0, binary: true };
  }
  return { insertions, deletions, binary: false };
}

function toPosixRelative(absPath: string, root: string): string | null {
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") return null;
  if (rel.startsWith("..")) return null;
  return rel.split(sep).join("/");
}

async function statsForRelativePath(
  root: string,
  relPosix: string,
  absPath: string,
): Promise<Omit<PathDiffStats, "path">> {
  const base = await resolveDiffBase(root);
  try {
    const { stdout: numstatOut } = await execGit(root, [
      "diff",
      "--numstat",
      base,
      "--",
      relPosix,
    ]);
    for (const line of numstatOut.split("\n")) {
      const parsed = parseNumstatLine(line);
      if (!parsed) continue;
      if (parsed.binary) {
        return {
          isRepo: true,
          insertions: 0,
          deletions: 0,
          hasDiff: false,
        };
      }
      if (parsed.insertions === 0 && parsed.deletions === 0) continue;
      return {
        isRepo: true,
        insertions: parsed.insertions,
        deletions: parsed.deletions,
        hasDiff: true,
      };
    }
  } catch {
    // Fall through to untracked check.
  }

  try {
    const { stdout: untrackedOut } = await execGit(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      relPosix,
    ]);
    if (untrackedOut.trim() === relPosix) {
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
    // ignore
  }

  return { isRepo: true, insertions: 0, deletions: 0, hasDiff: false };
}

/**
 * Per-path working-tree line stats for conversation File outputs.
 * Binary / non-text paths report `hasDiff: false` (UI hides +/-).
 */
export async function getPathsDiffStats(
  absolutePaths: string[],
): Promise<PathDiffStats[]> {
  const inputs = absolutePaths
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);

  const resolvedCache = new Map<string, PathDiffStats>();
  const out: PathDiffStats[] = [];

  for (const original of inputs) {
    const abs = resolve(original);
    const cached = resolvedCache.get(abs);
    if (cached) {
      out.push({ ...cached, path: original });
      continue;
    }

    const root = await resolveGitRoot(dirname(abs));
    if (!root) {
      const empty: PathDiffStats = {
        path: original,
        isRepo: false,
        insertions: 0,
        deletions: 0,
        hasDiff: false,
      };
      resolvedCache.set(abs, { ...empty, path: abs });
      out.push(empty);
      continue;
    }
    const rel = toPosixRelative(abs, root);
    if (!rel) {
      const empty: PathDiffStats = {
        path: original,
        isRepo: false,
        insertions: 0,
        deletions: 0,
        hasDiff: false,
      };
      resolvedCache.set(abs, { ...empty, path: abs });
      out.push(empty);
      continue;
    }

    try {
      const stats = await statsForRelativePath(root, rel, abs);
      const row: PathDiffStats = { path: original, ...stats };
      resolvedCache.set(abs, { ...row, path: abs });
      out.push(row);
    } catch {
      const empty: PathDiffStats = {
        path: original,
        isRepo: true,
        insertions: 0,
        deletions: 0,
        hasDiff: false,
      };
      resolvedCache.set(abs, { ...empty, path: abs });
      out.push(empty);
    }
  }

  return out;
}
