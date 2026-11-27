import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit } from "./execGit.js";
import { collectConflictPaths, mergeInProgress } from "./pull.js";
import { isGitRepo } from "./workingTree.js";
import type { WorkingTreeChangeStatus } from "./types.js";

export type MergeSideChoice = "mine" | "theirs" | "both";

export type IncomingChange = {
  path: string;
  status: WorkingTreeChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
};

export type BranchInfo = {
  isRepo: boolean;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
};

export type PullPreview = {
  isRepo: boolean;
  branch: string;
  upstream: string;
  merging: boolean;
  conflicts: string[];
  incoming: IncomingChange[];
  ahead: number;
  behind: number;
};

export type ResolveConflictResult =
  | { ok: true; remaining: string[] }
  | { ok: false; message: string };

export type FinishMergeResult =
  | { ok: true; shortHash: string; subject: string }
  | { ok: false; message: string };

const EMPTY_BRANCH: BranchInfo = {
  isRepo: false,
  branch: "",
  upstream: "",
  ahead: 0,
  behind: 0,
};

const NAME_STATUS: Record<string, WorkingTreeChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "modified",
};

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.trim() || "git command failed";
}

async function countCommits(cwd: string, range: string): Promise<number> {
  try {
    const { stdout } = await execGit(cwd, ["rev-list", "--count", range]);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

async function resolveBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return branch === "HEAD" ? "" : branch;
  } catch {
    return "";
  }
}

async function resolveUpstream(cwd: string): Promise<string> {
  try {
    const { stdout } = await execGit(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getBranchInfo(cwd: string): Promise<BranchInfo> {
  if (!(await isGitRepo(cwd))) return { ...EMPTY_BRANCH };
  const branch = await resolveBranch(cwd);
  const upstream = await resolveUpstream(cwd);
  if (!upstream) {
    return { isRepo: true, branch, upstream: "", ahead: 0, behind: 0 };
  }
  const ahead = await countCommits(cwd, "@{upstream}..HEAD");
  const behind = await countCommits(cwd, "HEAD..@{upstream}");
  return { isRepo: true, branch, upstream, ahead, behind };
}

/** Parse `git diff --name-status` output into path/status pairs. */
export function parseNameStatus(output: string): { path: string; status: WorkingTreeChangeStatus }[] {
  const rows: { path: string; status: WorkingTreeChangeStatus }[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const code = (parts[0] ?? "").slice(0, 1).toUpperCase();
    const status = NAME_STATUS[code];
    if (!status) continue;
    const path = (code === "R" || code === "C" ? parts[2] ?? parts[1] : parts[1]) ?? "";
    if (!path.trim()) continue;
    rows.push({ path: path.trim(), status });
  }
  return rows;
}

/** Parse `git diff --numstat` output into per-path line counts. */
export function parseNumstat(output: string): Map<string, { insertions: number; deletions: number; binary: boolean }> {
  const map = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const first = line.indexOf("\t");
    const second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = line.slice(0, first);
    const deleted = line.slice(first + 1, second);
    const path = line.slice(second + 1);
    if (!path) continue;
    const binary = added === "-" || deleted === "-";
    map.set(path, {
      insertions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return map;
}

async function diffRange(cwd: string, range: string): Promise<IncomingChange[]> {
  let names = "";
  try {
    const { stdout } = await execGit(cwd, ["diff", "--name-status", "--find-renames", range]);
    names = stdout;
  } catch {
    return [];
  }
  const rows = parseNameStatus(names);
  if (rows.length === 0) return [];
  let numstat = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
  try {
    const { stdout } = await execGit(cwd, ["diff", "--numstat", "--find-renames", range]);
    numstat = parseNumstat(stdout);
  } catch {
    numstat = new Map();
  }
  return rows.map(row => {
    const stats = numstat.get(row.path);
    return {
      path: row.path,
      status: row.status,
      insertions: stats?.insertions ?? 0,
      deletions: stats?.deletions ?? 0,
      binary: stats?.binary ?? false,
    };
  });
}

export async function getPullPreview(cwd: string): Promise<PullPreview> {
  const merging = await mergeInProgress(cwd);
  const branchInfo = await getBranchInfo(cwd);
  if (!branchInfo.isRepo) {
    return {
      isRepo: false,
      branch: "",
      upstream: "",
      merging,
      conflicts: [],
      incoming: [],
      ahead: 0,
      behind: 0,
    };
  }
  const conflicts = merging ? await collectConflictPaths(cwd) : [];
  const range = merging ? "HEAD...MERGE_HEAD" : branchInfo.upstream ? "HEAD...@{upstream}" : "";
  const incoming = range ? await diffRange(cwd, range) : [];
  return {
    isRepo: true,
    branch: branchInfo.branch,
    upstream: branchInfo.upstream,
    merging,
    conflicts,
    incoming,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
  };
}

async function conflictStages(cwd: string, path: string): Promise<Set<number>> {
  try {
    const { stdout } = await execGit(cwd, ["ls-files", "-u", "--", path]);
    const stages = new Set<number>();
    for (const line of stdout.split("\n")) {
      const match = /^[0-9]+\s+[0-9a-f]+\s+([123])\t/.exec(line);
      if (match?.[1]) stages.add(Number(match[1]));
    }
    return stages;
  } catch {
    return new Set();
  }
}

async function readStage(cwd: string, path: string, stage: 1 | 2 | 3): Promise<string> {
  if (!(await conflictStages(cwd, path)).has(stage)) return "";
  const { stdout } = await execGit(cwd, ["show", `:${stage}:${path}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function writeUnion(cwd: string, path: string, mine: string, theirs: string): Promise<void> {
  const base = await readStage(cwd, path, 1);
  const dir = await mkdtemp(join(tmpdir(), "jellybot-merge-"));
  const oursFile = join(dir, "ours");
  const baseFile = join(dir, "base");
  const theirsFile = join(dir, "theirs");
  try {
    await writeFile(oursFile, mine, "utf8");
    await writeFile(baseFile, base, "utf8");
    await writeFile(theirsFile, theirs, "utf8");
    const { stdout } = await execGit(cwd, [
      "merge-file",
      "-p",
      "--union",
      oursFile,
      baseFile,
      theirsFile,
    ]);
    await writeFile(join(cwd, path), stdout, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function resolveMergeConflict(
  cwd: string,
  relativePath: string,
  choice: MergeSideChoice,
): Promise<ResolveConflictResult> {
  const path = relativePath.trim();
  if (!path) return { ok: false, message: "No file was given." };
  if (!(await mergeInProgress(cwd))) {
    return { ok: false, message: "No merge is in progress." };
  }
  const stage = choice === "mine" ? 2 : 3;
  try {
    if (choice === "both") {
      await writeUnion(cwd, path, await readStage(cwd, path, 2), await readStage(cwd, path, 3));
    } else if ((await conflictStages(cwd, path)).has(stage)) {
      await execGit(cwd, ["checkout", choice === "mine" ? "--ours" : "--theirs", "--", path]);
    } else {
      // The chosen side deleted this file, so keeping it means keeping the deletion.
      await execGit(cwd, ["rm", "-f", "--quiet", "--", path]);
      return { ok: true, remaining: await collectConflictPaths(cwd) };
    }
    await execGit(cwd, ["add", "--", path]);
    return { ok: true, remaining: await collectConflictPaths(cwd) };
  } catch (err) {
    return {
      ok: false,
      message: `Could not keep the ${choice === "mine" ? "local" : choice === "theirs" ? "incoming" : "combined"} version of ${path} — ${errorText(err)}`,
    };
  }
}

export async function finishMerge(cwd: string): Promise<FinishMergeResult> {
  if (!(await mergeInProgress(cwd))) {
    return { ok: false, message: "No merge is in progress." };
  }
  const conflicts = await collectConflictPaths(cwd);
  if (conflicts.length > 0) {
    return {
      ok: false,
      message: `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} still conflicted.`,
    };
  }
  try {
    await execGit(cwd, ["commit", "--no-edit"], { timeoutMs: 120_000 });
    const { stdout } = await execGit(cwd, ["log", "-1", "--pretty=%h%n%s"]);
    const [shortHash = "", subject = ""] = stdout.trim().split("\n");
    return { ok: true, shortHash, subject };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}
