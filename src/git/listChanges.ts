import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execGit } from "./execGit.js";
import { isGitRepo } from "./workingTree.js";
import {
  claimScanBudget,
  countLinesIn,
  createScanBudget,
  readCappedText,
  type ScanBudget,
} from "../vcs/readCapped.js";
import type {
  WorkingTreeChange,
  WorkingTreeChangeStatus,
  WorkingTreeChangesResult,
  WorkingTreePathDiff,
} from "./types.js";

/** Well-known SHA-1 empty tree OID (no commits yet). */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d6927bbc6c6eb";

/** Soft cap bytes per side when loading path text for diff preview. */
const PATH_DIFF_READ_CAP = 512 * 1024;

const HIDDEN: WorkingTreeChangesResult = { isRepo: false, files: [] };
const EMPTY_REPO: WorkingTreeChangesResult = { isRepo: true, files: [] };

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
  const pathPart = trimmed.slice(tab2 + 1);
  // Renames: "old\tnew" — use destination path.
  const path = (pathPart.split("\t").pop() ?? "").trim();
  if (!path) return null;
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

function statusFromPorcelain(
  xy: string,
  isUntracked: boolean,
): WorkingTreeChangeStatus {
  if (isUntracked) return "untracked";
  const codes = `${xy[0] ?? " "}${xy[1] ?? " "}`;
  if (codes.includes("R")) return "renamed";
  if (codes.includes("C")) return "copied";
  if (codes.includes("A")) return "added";
  if (codes.includes("D") && !codes.includes("M")) return "deleted";
  if (codes.includes("D") && codes.includes("M")) return "modified";
  return "modified";
}

type PorcelainEntry = {
  path: string;
  oldPath?: string;
  status: WorkingTreeChangeStatus;
};

function parsePorcelainLine(line: string): PorcelainEntry | null {
  const trimmed = line.trimEnd();
  if (trimmed.length < 3) return null;

  if (trimmed.startsWith("??") || trimmed.startsWith("!!")) {
    const path = trimmed.slice(2).trim();
    if (!path) return null;
    return { path, status: "untracked" };
  }

  const xy = trimmed.slice(0, 2);
  const rest = trimmed.slice(2).trimStart();
  if (!rest) return null;

  const arrow = rest.indexOf(" -> ");
  if (arrow >= 0) {
    const oldPath = rest.slice(0, arrow).trim();
    const path = rest.slice(arrow + 4).trim();
    if (!path) return null;
    const entry: PorcelainEntry = {
      path,
      status: statusFromPorcelain(xy, false),
    };
    if (oldPath) entry.oldPath = oldPath;
    return entry;
  }

  return { path: rest, status: statusFromPorcelain(xy, false) };
}

async function countUntrackedLines(
  cwd: string,
  relativePath: string,
  budget: ScanBudget,
): Promise<{ lines: number; binary: boolean }> {
  const abs = join(cwd, relativePath);
  let size = 0;
  try {
    size = (await stat(abs)).size;
  } catch {
    return { lines: 1, binary: false };
  }
  // Out of scan budget: list the file without opening it.
  if (!claimScanBudget(budget, size)) return { lines: 1, binary: false };
  const result = await readCappedText(abs);
  if (!result) return { lines: 1, binary: false };
  if (result.binary) return { lines: 1, binary: true };
  return { lines: Math.max(1, countLinesIn(result.text)), binary: false };
}

function normalizeRelativePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.includes("\0")) return null;
  if (path === ".." || path.startsWith("../") || path.includes("/../")) {
    return null;
  }
  return path;
}

async function showBaseBlob(
  cwd: string,
  base: string,
  relativePath: string,
): Promise<{ text: string; truncated: boolean; binary: boolean } | null> {
  try {
    const { stdout } = await execGit(
      cwd,
      ["show", `${base}:${relativePath}`],
      { maxBuffer: PATH_DIFF_READ_CAP + 64 * 1024 },
    );
    // execGit returns string; detect NUL via code units.
    if (stdout.includes("\0")) {
      return { text: "", truncated: false, binary: true };
    }
    if (stdout.length > PATH_DIFF_READ_CAP) {
      return {
        text: stdout.slice(0, PATH_DIFF_READ_CAP),
        truncated: true,
        binary: false,
      };
    }
    return { text: stdout, truncated: false, binary: false };
  } catch {
    return null;
  }
}

/**
 * List dirty working-tree paths with coarse status and +/- line counts.
 */
export async function listWorkingTreeChanges(
  cwd: string,
): Promise<WorkingTreeChangesResult> {
  if (!(await isGitRepo(cwd))) {
    return { ...HIDDEN };
  }

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

    if (statusLines.length === 0) {
      return { ...EMPTY_REPO };
    }

    const entries: PorcelainEntry[] = [];
    const byPath = new Map<string, PorcelainEntry>();
    for (const line of statusLines) {
      const parsed = parsePorcelainLine(line);
      if (!parsed) continue;
      byPath.set(parsed.path, parsed);
    }
    for (const entry of byPath.values()) {
      entries.push(entry);
    }

    const base = await resolveDiffBase(cwd);
    const numstatByPath = new Map<
      string,
      { insertions: number; deletions: number; binary: boolean }
    >();
    try {
      const { stdout: numstatOut } = await execGit(cwd, [
        "diff",
        "--numstat",
        base,
      ]);
      for (const line of numstatOut.split("\n")) {
        const parsed = parseNumstatLine(line);
        if (!parsed) continue;
        numstatByPath.set(parsed.path, {
          insertions: parsed.insertions,
          deletions: parsed.deletions,
          binary: parsed.binary,
        });
      }
    } catch {
      // Keep status entries without numstat.
    }

    const files: WorkingTreeChange[] = [];
    const budget = createScanBudget();
    for (const entry of entries) {
      const stats = numstatByPath.get(entry.path);
      if (entry.status === "untracked") {
        const counted = await countUntrackedLines(cwd, entry.path, budget);
        files.push({
          path: entry.path,
          status: "untracked",
          insertions: counted.binary ? 1 : counted.lines,
          deletions: 0,
          binary: counted.binary,
        });
        continue;
      }

      if (stats) {
        const row: WorkingTreeChange = {
          path: entry.path,
          status: entry.status,
          insertions: stats.insertions,
          deletions: stats.deletions,
          binary: stats.binary,
        };
        if (entry.oldPath) row.oldPath = entry.oldPath;
        files.push(row);
        continue;
      }

      // Status-only (mode change, etc.) — still list with zeros.
      const row: WorkingTreeChange = {
        path: entry.path,
        status: entry.status,
        insertions: 0,
        deletions: 0,
        binary: false,
      };
      if (entry.oldPath) row.oldPath = entry.oldPath;
      files.push(row);
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return { isRepo: true, files };
  } catch {
    return { ...HIDDEN };
  }
}

/**
 * Load before/after text for a single dirty path (lined diff in the UI).
 */
export async function getWorkingTreePathDiff(
  cwd: string,
  relativePathRaw: string,
): Promise<WorkingTreePathDiff> {
  const relativePath = normalizeRelativePath(relativePathRaw);
  if (!relativePath) {
    return {
      path: typeof relativePathRaw === "string" ? relativePathRaw : "",
      binary: false,
      before: "",
      after: "",
      truncated: false,
    };
  }

  if (!(await isGitRepo(cwd))) {
    return {
      path: relativePath,
      binary: false,
      before: "",
      after: "",
      truncated: false,
    };
  }

  const base = await resolveDiffBase(cwd);
  const abs = join(cwd, relativePath);

  // Prefer numstat binary flag when available.
  let numstatBinary = false;
  try {
    const { stdout: numstatOut } = await execGit(cwd, [
      "diff",
      "--numstat",
      base,
      "--",
      relativePath,
    ]);
    for (const line of numstatOut.split("\n")) {
      const parsed = parseNumstatLine(line);
      if (parsed?.binary) {
        numstatBinary = true;
        break;
      }
    }
  } catch {
    // ignore
  }

  let beforeResult = await showBaseBlob(cwd, base, relativePath);
  // Renames: destination may not exist at base — load content from old path.
  if (!beforeResult) {
    try {
      const { stdout: porcelain } = await execGit(cwd, [
        "status",
        "--porcelain",
        "-uall",
        "--",
        relativePath,
      ]);
      for (const line of porcelain.split("\n")) {
        const entry = parsePorcelainLine(line.trimEnd());
        if (entry?.path === relativePath && entry.oldPath) {
          beforeResult = await showBaseBlob(cwd, base, entry.oldPath);
          break;
        }
      }
    } catch {
      // ignore
    }
  }
  const afterResult = await readCappedText(abs);

  if (numstatBinary || beforeResult?.binary || afterResult?.binary) {
    return {
      path: relativePath,
      binary: true,
      before: "",
      after: "",
      truncated: false,
    };
  }

  // Untracked binary already handled via afterResult.binary.
  // Missing after + missing before → empty preview.
  const before = beforeResult?.text ?? "";
  const after = afterResult?.text ?? "";
  const truncated =
    (beforeResult?.truncated ?? false) || (afterResult?.truncated ?? false);

  return {
    path: relativePath,
    binary: false,
    before,
    after,
    truncated,
  };
}
