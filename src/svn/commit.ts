import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSvn, execSvnWithAuth, SvnCommandError } from "./execSvn.js";
import { collectSvnChanges } from "./collect.js";
import { parseSvnCommitRevision, parseSvnStatus } from "./parseSvn.js";

export type CreatedSvnCommit = {
  /** "r123" — parsed from "Committed revision 123." (empty when unparseable). */
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

/** `svn status` prints native separators; compare on one shape. */
function toPosix(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Keep only top-most unversioned paths (adding a parent adds its children). */
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

/**
 * Commit everything in the working copy — SVN parity of git's `add -A` +
 * commit flow:
 * 1. missing (`!`) files are scheduled for deletion (`svn rm`);
 * 2. unversioned (`?`) entries are `svn add`ed (top-most only);
 * 3. `svn commit -F <tempfile>` runs at the WC root (message via file to
 *    dodge argv length limits; `--non-interactive` avoids prompt hangs).
 */
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
      // Lost races with concurrent adds are fine — anything else aborts.
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
    // Our own just-created temp dir — safe to remove unconditionally.
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Commit only `paths` (relative to `cwd`) — the Dev Mode tree's per-file
 * commit. Same preparation as {@link svnCommitAll} but narrowed to the
 * selection: missing entries are `svn rm`ed, unversioned ones `svn add`ed, and
 * every command runs at `cwd` so the given relative paths stay valid.
 *
 * Newly added parent directories are pulled into the target list: svn refuses
 * to commit a child whose scheduled-add parent is not part of the same commit.
 */
export async function svnCommitPaths(
  cwd: string,
  message: string,
  paths: string[],
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
  try {
    const { stdout } = await execSvn(cwd, ["status", "--", ...scope]);
    scoped = stdout;
  } catch (err) {
    throw new Error(`svn status failed: ${errorDetail(err)}`);
  }
  const entries = parseSvnStatus(scoped)
    .filter((entry) => entry.kind !== "obscured")
    .map((entry) => ({ ...entry, path: toPosix(entry.path) }));
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
      // Lost races with concurrent adds are fine — anything else aborts.
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
        ["commit", "-F", messageFile, "--", ...targets],
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

/**
 * Directories scheduled for add that sit above a target — svn fails the commit
 * ("is not known to exist in the repository") unless they go in with it.
 * Shallowest first so the commit target order mirrors the tree.
 */
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
