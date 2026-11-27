import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSvn, execSvnWithAuth, SvnCommandError } from "./execSvn.js";
import { collectSvnChanges } from "./collect.js";
import { parseSvnCommitRevision, parseSvnStatus, type SvnStatusEntry } from "./parseSvn.js";

export type CreatedSvnCommit = {
  hash: string;
  shortHash: string;
  message: string;
  subject: string;
  vcs: "svn";
};

function errorDetail(err: unknown): string {
  if (err instanceof SvnCommandError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function topMostPaths(paths: string[]): string[] {
  const sorted = [...paths].sort();
  const kept: string[] = [];
  for (const path of sorted) {
    const parent = kept[kept.length - 1];
    if (parent && (path === parent || path.startsWith(`${parent}/`))) {
      continue;
    }
    kept.push(path);
  }
  return kept;
}

export async function svnCommitAll(
  cwd: string,
  message: string,
): Promise<CreatedSvnCommit> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("Commit message is empty");
  }

  const collected = await collectSvnChanges(cwd);
  if (!collected) {
    throw new Error("Not an SVN working copy");
  }
  if (collected.changes.length === 0) {
    throw new Error("No changes to commit");
  }
  const root = collected.root;

  for (const change of collected.changes) {
    if (change.kind !== "missing") continue;
    try {
      await execSvn(root, ["rm", "--", change.path]);
    } catch (err) {
      throw new Error(`svn rm failed: ${errorDetail(err)}`);
    }
  }

  const unversioned = collected.changes
    .filter((change) => change.kind === "untracked")
    .map((change) => change.path);
  for (const path of topMostPaths(unversioned)) {
    try {
      await execSvn(root, ["add", "--parents", "--", path]);
    } catch (err) {
      const detail = errorDetail(err);
      if (!/already under version control|E150002/i.test(detail)) {
        throw new Error(`svn add failed: ${detail}`);
      }
    }
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "jellybot-svn-commit-"));
  try {
    const messageFile = join(tmpDir, "message.txt");
    await writeFile(messageFile, trimmed, "utf8");
    let stdout = "";
    try {
      const result = await execSvnWithAuth(root, ["commit", "-F", messageFile], {
        operation: "Commit",
      });
      stdout = result.stdout;
    } catch (err) {
      throw new Error(`svn commit failed: ${errorDetail(err)}`);
    }

    const revision = parseSvnCommitRevision(stdout);
    const subject = trimmed.split(/\r?\n/)[0]?.trim() ?? trimmed;
    return {
      hash: revision ?? "",
      shortHash: revision ?? "",
      message: trimmed,
      subject,
      vcs: "svn",
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function svnCommitPaths(
  cwd: string,
  message: string,
  paths: string[],
  options?: { depth: "empty" },
): Promise<CreatedSvnCommit> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("Commit message is empty");
  }
  const scope = paths.map(toPosix).filter((path) => path.length > 0);
  if (scope.length === 0) {
    throw new Error("No paths to commit");
  }

  let scoped: string;
  let warnings: string;
  try {
    const { stdout, stderr } = await execSvn(cwd, ["status", "--", ...scope]);
    scoped = stdout;
    warnings = stderr;
  } catch (err) {
    throw new Error(`svn status failed: ${errorDetail(err)}`);
  }
  const entries: SvnStatusEntry[] = parseSvnStatus(scoped)
    .filter((entry) => entry.kind !== "obscured")
    .map((entry) => ({ ...entry, path: toPosix(entry.path) }));
  if (/W155010/.test(warnings)) {
    for (const path of scope) {
      if (entries.some((entry) => isUnder(path, entry.path))) continue;
      if (await pathExists(join(cwd, path))) entries.push({ kind: "untracked", path });
    }
  }
  if (entries.length === 0) {
    throw new Error("No changes to commit");
  }

  for (const entry of entries) {
    if (entry.kind !== "missing") continue;
    try {
      await execSvn(cwd, ["rm", "--", entry.path]);
    } catch (err) {
      throw new Error(`svn rm failed: ${errorDetail(err)}`);
    }
  }

  const unversioned = entries
    .filter((entry) => entry.kind === "untracked")
    .map((entry) => entry.path);
  for (const path of topMostPaths(unversioned)) {
    try {
      await execSvn(cwd, ["add", "--parents", "--", path]);
    } catch (err) {
      const detail = errorDetail(err);
      if (!/already under version control|E150002/i.test(detail)) {
        throw new Error(`svn add failed: ${detail}`);
      }
    }
  }

  const targets = [
    ...(await scheduledAddAncestors(cwd, scope)),
    ...scope,
  ];

  const tmpDir = await mkdtemp(join(tmpdir(), "jellybot-svn-commit-"));
  try {
    const messageFile = join(tmpDir, "message.txt");
    await writeFile(messageFile, trimmed, "utf8");
    let stdout = "";
    try {
      const result = await execSvnWithAuth(
        cwd,
        ["commit", "-F", messageFile, ...(options ? ["--depth", options.depth] : []), "--", ...targets],
        { operation: "Commit" },
      );
      stdout = result.stdout;
    } catch (err) {
      throw new Error(`svn commit failed: ${errorDetail(err)}`);
    }

    const revision = parseSvnCommitRevision(stdout);
    const subject = trimmed.split(/\r?\n/)[0]?.trim() ?? trimmed;
    return {
      hash: revision ?? "",
      shortHash: revision ?? "",
      message: trimmed,
      subject,
      vcs: "svn",
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function pickScheduledAddAncestors(
  addedPaths: string[],
  targets: string[],
): string[] {
  const added = addedPaths.map(toPosix);
  const scope = targets.map(toPosix);
  const ancestors = added.filter((candidate) =>
    scope.some((target) => target !== candidate && isUnder(target, candidate)),
  );
  return [...new Set(ancestors)].sort(
    (a, b) => a.split("/").length - b.split("/").length,
  );
}

async function scheduledAddAncestors(
  cwd: string,
  targets: string[],
): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execSvn(cwd, ["status"]));
  } catch {
    return [];
  }
  const added = parseSvnStatus(stdout)
    .filter((entry) => entry.kind === "added")
    .map((entry) => entry.path);
  return pickScheduledAddAncestors(added, targets);
}
