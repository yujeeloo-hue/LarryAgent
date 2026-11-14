/**
 * Whether `svn update` on a working copy would bring new repository
 * revisions. Compares the root's checked-out revision with HEAD — one
 * pair of `svn info` calls, not a full `svn status -u` tree walk.
 * Auth or network failure reads as "nothing to show": a background poll
 * must not surface Update just because the check could not finish.
 */
import { execSvn } from "./execSvn.js";

/** True when the repository HEAD revision is newer than the working copy. */
export function svnRevisionIsBehind(localRevision: string, headRevision: string): boolean {
  const local = Number.parseInt(localRevision.trim(), 10);
  const head = Number.parseInt(headRevision.trim(), 10);
  return Number.isFinite(local) && Number.isFinite(head) && head > local;
}

async function revisionItem(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execSvn(cwd, ["info", ...args, "--show-item", "revision"]);
    const revision = stdout.trim();
    return revision || null;
  } catch {
    return null;
  }
}

/** True when the working copy root is behind the repository HEAD. */
export async function isSvnUpdateAvailable(cwd: string): Promise<boolean> {
  const [local, head] = await Promise.all([
    revisionItem(cwd, []),
    revisionItem(cwd, ["-r", "HEAD"]),
  ]);
  if (!local || !head) return false;
  return svnRevisionIsBehind(local, head);
}
