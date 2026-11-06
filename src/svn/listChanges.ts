import { join } from "node:path";
import { execSvn } from "./execSvn.js";
import { collectSvnChanges, resolveSvnWcRoot } from "./collect.js";
import { parseSvnDiffCounts, parseSvnStatus } from "./parseSvn.js";
import { readCappedText, TEXT_READ_CAP } from "./readText.js";
import type {
  WorkingTreeChange,
  WorkingTreeChangesResult,
  WorkingTreePathDiff,
} from "../git/types.js";

const HIDDEN: WorkingTreeChangesResult = { isRepo: false, files: [] };
const EMPTY: WorkingTreeChangesResult = { isRepo: true, files: [] };

function normalizeRelativePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.includes("\0")) return null;
  if (path === ".." || path.startsWith("../") || path.includes("/../")) {
    return null;
  }
  return path;
}

/** List dirty WC paths with coarse status and +/- line counts. */
export async function listSvnWorkingTreeChanges(
  cwd: string,
): Promise<WorkingTreeChangesResult> {
  const collected = await collectSvnChanges(cwd);
  if (!collected) {
    return { ...HIDDEN };
  }

  const files: WorkingTreeChange[] = collected.changes.map((change) => ({
    path: change.path,
    status: change.status,
    insertions: change.insertions,
    deletions: change.deletions,
    binary: change.binary,
  }));

  return { isRepo: true, files };
}

/**
 * Load before/after text for a single dirty path (lined diff in the UI).
 * Before comes from `svn cat -r BASE`; untracked/added paths have no base.
 */
export async function getSvnWorkingTreePathDiff(
  cwd: string,
  relativePathRaw: string,
): Promise<WorkingTreePathDiff> {
  const relativePath = normalizeRelativePath(relativePathRaw);
  const empty: WorkingTreePathDiff = {
    path: typeof relativePathRaw === "string" ? relativePathRaw : "",
    binary: false,
    before: "",
    after: "",
    truncated: false,
  };
  if (!relativePath) return empty;

  const root = await resolveSvnWcRoot(cwd);
  if (!root) {
    return { ...empty, path: relativePath };
  }

  const abs = join(root, relativePath);

  // Cheap single-path status (avoids a full-tree collect per preview click).
  let isUnversionedOrAdded = false;
  try {
    const { stdout } = await execSvn(root, ["status", "--", relativePath]);
    for (const entry of parseSvnStatus(stdout)) {
      if (entry.kind === "untracked" || entry.kind === "added") {
        isUnversionedOrAdded = true;
      }
    }
  } catch {
    isUnversionedOrAdded = false;
  }

  // Binary detection via the per-path diff marker line.
  let binary = false;
  try {
    const { stdout } = await execSvn(root, ["diff", "--", relativePath]);
    const counts = parseSvnDiffCounts(stdout).get(relativePath);
    binary = counts?.binary === true;
  } catch {
    binary = false;
  }

  let before: { text: string; truncated: boolean } | null = null;
  if (!isUnversionedOrAdded) {
    try {
      const { stdout } = await execSvn(
        root,
        ["cat", "-r", "BASE", "--", relativePath],
        { maxBuffer: TEXT_READ_CAP + 64 * 1024 },
      );
      if (stdout.includes("\0")) {
        binary = true;
      } else if (stdout.length > TEXT_READ_CAP) {
        before = { text: stdout.slice(0, TEXT_READ_CAP), truncated: true };
      } else {
        before = { text: stdout, truncated: false };
      }
    } catch {
      // Deleted-from-disk (missing) still has a BASE; unreadable base → empty.
      before = null;
    }
  }

  const afterResult = await readCappedText(abs);

  if (binary || afterResult?.binary) {
    return { path: relativePath, binary: true, before: "", after: "", truncated: false };
  }

  return {
    path: relativePath,
    binary: false,
    before: before?.text ?? "",
    after: afterResult?.text ?? "",
    truncated: (before?.truncated ?? false) || (afterResult?.truncated ?? false),
  };
}
