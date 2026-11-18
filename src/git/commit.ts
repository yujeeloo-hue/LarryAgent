import { execGit, GitCommandError } from "./execGit.js";

export type CreatedCommit = {
  hash: string;
  shortHash: string;
  message: string;
  subject: string;
  vcs: "git";
};

export async function commitPaths(
  cwd: string,
  message: string,
  paths?: string[],
): Promise<CreatedCommit> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("Commit message is empty");
  }
  const scope = (paths ?? []).filter((path) => path.trim().length > 0);
  if (paths !== undefined && scope.length === 0) {
    throw new Error("No paths to commit");
  }
  const scopedOptions = scope.length ? { env: { GIT_LITERAL_PATHSPECS: "1" } } : {};

  try {
    await execGit(cwd, ["add", "-A", ...(scope.length > 0 ? ["--", ...scope] : [])], scopedOptions);
  } catch (err) {
    const detail =
      err instanceof GitCommandError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`git add failed: ${detail}`);
  }

  try {
    await execGit(
      cwd,
      ["commit", "-F", "-", ...(scope.length > 0 ? ["--", ...scope] : [])],
      { ...scopedOptions, input: trimmed },
    );
  } catch (err) {
    const detail =
      err instanceof GitCommandError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`git commit failed: ${detail}`);
  }

  let hash = "";
  let subject = trimmed.split(/\r?\n/)[0]?.trim() ?? trimmed;
  try {
    const head = await execGit(cwd, ["rev-parse", "HEAD"]);
    hash = head.stdout.trim();
  } catch {
    hash = "";
  }
  try {
    const sub = await execGit(cwd, ["log", "-1", "--pretty=%s"]);
    const line = sub.stdout.trim();
    if (line) subject = line;
  } catch {
  }

  const shortHash = hash.length >= 7 ? hash.slice(0, 7) : hash;
  return {
    hash,
    shortHash,
    message: trimmed,
    subject,
    vcs: "git",
  };
}
