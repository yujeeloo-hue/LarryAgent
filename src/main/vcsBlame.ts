/**
 * Annotate (blame) dispatch for the Dev Mode editor — git or svn depending
 * on the workspace. Runs one VCS subprocess per request; the renderer only
 * asks when the user toggles Annotate on (and after saves/disk reloads),
 * so no caching is warranted.
 */
import { gitBlame, type BlameLine } from "../git/blame.js";
import { svnBlame } from "../svn/blame.js";
import { detectVcs } from "../vcs/index.js";
import { isVcsAuthFailure } from "../vcs/vcsAuth.js";

export type VcsBlameResult =
  | { ok: true; kind: "git" | "svn"; lines: BlameLine[] }
  | { ok: false; message: string };

/** posix-style `absPath` relative to `root` (null when outside). */
function relFromRoot(root: string, absPath: string): string | null {
  const rootN = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = absPath.replace(/\\/g, "/");
  if (!abs.startsWith(`${rootN}/`)) return null;
  return abs.slice(rootN.length + 1);
}

/** Friendlier wording for the common "file not in the VCS yet" failures. */
function friendlyError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : String(err ?? "blame failed");
  if (/no such path .* in HEAD|does not exist in HEAD|has no commits yet/i.test(message)) {
    return "File is not tracked by Git yet (uncommitted or untracked)";
  }
  if (/W155010|is not under version control/i.test(message)) {
    return "File is not under SVN version control";
  }
  if (/E200009|is a binary/i.test(message)) {
    return "Cannot annotate this file";
  }
  // Auth failures that survived the ask+retry flow (dismissed dialog) —
  // point at the reason instead of raw E170001 wording.
  if (isVcsAuthFailure(message)) {
    return "Sign-in was cancelled — credentials are required to annotate";
  }
  return message.trim() || "blame failed";
}

export async function getVcsBlame(
  root: string,
  absPath: string,
): Promise<VcsBlameResult> {
  const rel = relFromRoot(root, absPath);
  if (rel === null) {
    return { ok: false, message: "File is outside the workspace root" };
  }
  const kind = await detectVcs(root);
  try {
    if (kind === "git") {
      return { ok: true, kind, lines: await gitBlame(root, rel) };
    }
    if (kind === "svn") {
      return { ok: true, kind, lines: await svnBlame(root, rel) };
    }
    return {
      ok: false,
      message: "Workspace is not a Git repository or SVN working copy",
    };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}
