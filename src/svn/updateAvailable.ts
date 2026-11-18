import { execSvn } from "./execSvn.js";

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

export async function isSvnUpdateAvailable(cwd: string): Promise<boolean> {
  const [local, head] = await Promise.all([
    revisionItem(cwd, []),
    revisionItem(cwd, ["-r", "HEAD"]),
  ]);
  if (!local || !head) return false;
  return svnRevisionIsBehind(local, head);
}
