/**
 * `git pull` for the conversation git bar Pull button.
 *
 * Mirrors push.ts: GIT_TERMINAL_PROMPT=0 keeps a credential-less HTTPS
 * remote from hanging the IPC on an invisible prompt (keychain/ssh-agent
 * credentials still work — only terminal asks fail fast). When that
 * fail-fast error is an auth failure, an HTTPS remote asks once (renderer
 * dialog, vcsAuth) and retries with the credentials injected as env-only
 * config — no argv, no config-file edits. SSH remotes never get a dialog
 * (a username/password is noise there) and fail with a hint instead.
 *
 * Merge semantics are fixed: `git pull --no-rebase --no-edit` so a conflict
 * always leaves a plain merge state (conflict markers + MERGE_HEAD) that
 * the LLM resolution session — or the user — can finish or abort.
 */
import { execGit, GitCommandError } from "./execGit.js";
import {
  askVcsCredentials,
  buildGitAuthEnv,
  gitRemoteUrl,
  isVcsAuthFailure,
} from "../vcs/vcsAuth.js";
import { isSshRemoteUrl } from "./sshFallback.js";

const PULL_TIMEOUT_MS = 120_000;

export type GitPullResult =
  | { ok: true; output: string; updated: boolean }
  | { ok: false; conflicts: string[]; message: string; output: string }
  | { ok: false; message: string };

export type GitAbortMergeResult =
  | { ok: true }
  | { ok: false; message: string };

/** Unmerged index states in `git status --porcelain` (XY column). */
const CONFLICT_STATUS_RE = /^(?:DD|AU|UD|UA|DU|UU|AA)\s/;
/** "Already up to date." (git ≤2.43) / "Already up to date" newer wording. */
const ALREADY_UP_TO_DATE_RE = /already up[- ]to[- ]date/i;

/** True while a merge is waiting to be concluded (MERGE_HEAD exists). */
async function mergeInProgress(cwd: string): Promise<boolean> {
  try {
    await execGit(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Repo-relative paths of unmerged entries; empty on any git failure. */
async function collectConflictPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execGit(cwd, ["status", "--porcelain"]);
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => CONFLICT_STATUS_RE.test(line))
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** SSH remotes cannot be helped by a credential dialog — hint instead. */
function withSshHint(message: string, remoteUrl: string): string {
  const m = message.toLowerCase();
  const hint = m.includes("host key verification failed")
    ? " — run `ssh -T` against the remote host once in Terminal to accept its host key"
    : isSshRemoteUrl(remoteUrl) && !m.includes("not a git repository")
      ? " — SSH key auth failed; check `ssh-add -l` / ~/.ssh/config, or verify with `ssh -T` in Terminal"
      : "";
  return hint ? `${message}${hint}` : message;
}

/** One `git pull --no-rebase --no-edit` attempt. */
async function attemptPull(
  cwd: string,
  env?: Record<string, string>,
): Promise<{ done: true; result: GitPullResult } | { done: false; error: GitCommandError }> {
  try {
    const res = await execGit(cwd, ["pull", "--no-rebase", "--no-edit"], {
      env: env ? { GIT_TERMINAL_PROMPT: "0", ...env } : { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: PULL_TIMEOUT_MS,
    });
    const output = `${res.stdout}${res.stderr}`.trim();
    return {
      done: true,
      result: { ok: true, output, updated: !ALREADY_UP_TO_DATE_RE.test(output) },
    };
  } catch (err) {
    if (err instanceof GitCommandError) return { done: false, error: err };
    return {
      done: true,
      result: { ok: false, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Turn a failed pull into a result: a merge state on disk means conflicts
 * (path list from the index), an auth failure routes to the credential
 * flow, everything else is a plain error.
 */
async function classifyPullFailure(
  cwd: string,
  error: GitCommandError,
): Promise<GitPullResult | { auth: true; message: string }> {
  const message = error.stderr.trim() || error.message;
  if (await mergeInProgress(cwd)) {
    return {
      ok: false,
      conflicts: await collectConflictPaths(cwd),
      message,
      output: error.stderr.trim(),
    };
  }
  if (isVcsAuthFailure(error.message)) return { auth: true, message };
  return { ok: false, message };
}

export async function pullLatest(cwd: string): Promise<GitPullResult> {
  // A previous pull (or a manual merge) may still be unresolved — pulling
  // again would just fail with "You have not concluded your merge". Read
  // the on-disk conflicts instead so the three-way dialog can re-open.
  if (await mergeInProgress(cwd)) {
    const conflicts = await collectConflictPaths(cwd);
    if (conflicts.length > 0) {
      return {
        ok: false,
        conflicts,
        message: "A merge is already in progress with unresolved conflicts.",
        output: "",
      };
    }
    return {
      ok: false,
      message:
        "A merge is already in progress with no unresolved conflict files. Finish or abort the merge first.",
    };
  }

  const first = await attemptPull(cwd);
  if (first.done) return first.result;
  const firstClassified = await classifyPullFailure(cwd, first.error);
  if (!("auth" in firstClassified)) return firstClassified;

  // Auth failure. Resolve the remote once — it drives the recovery paths.
  let remoteUrl = "";
  try {
    remoteUrl = await gitRemoteUrl(cwd);
  } catch {
    remoteUrl = "";
  }

  // SSH remotes have no username/password — a credential dialog is noise.
  if (isSshRemoteUrl(remoteUrl)) {
    return { ok: false, message: withSshHint(firstClassified.message, remoteUrl) };
  }

  // HTTPS remote → ask + retry (a rejected password re-asks, bounded).
  let lastError = firstClassified.message;
  for (let attempt = 0; attempt < 3; attempt++) {
    const credentials = await askVcsCredentials({
      vcs: "git",
      operation: "Pull",
      context: remoteUrl || cwd,
      detail: lastError,
    });
    if (!credentials) break;
    const retry = await attemptPull(cwd, buildGitAuthEnv(remoteUrl || "*", credentials));
    if (retry.done) return retry.result;
    const retryClassified = await classifyPullFailure(cwd, retry.error);
    if (!("auth" in retryClassified)) return retryClassified;
    lastError = retryClassified.message;
  }
  return { ok: false, message: lastError };
}

/** Roll the working tree back to the pre-merge state (`git merge --abort`). */
export async function abortMerge(cwd: string): Promise<GitAbortMergeResult> {
  if (!(await mergeInProgress(cwd))) {
    return { ok: false, message: "No merge is in progress." };
  }
  try {
    await execGit(cwd, ["merge", "--abort"], {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: PULL_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof GitCommandError
          ? err.stderr.trim() || err.message
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
}

/**
 * Silent background fetch for Pull-button visibility. Never prompts
 * (GIT_TERMINAL_PROMPT=0): auth/network failures resolve ok:false quietly —
 * the caller keeps the button in its "upstream unknown" fallback instead of
 * surfacing a dialog. Runs `git fetch` by remote name so remote-tracking
 * refs (and therefore behindCount) advance.
 */
export async function backgroundFetch(cwd: string): Promise<boolean> {
  try {
    await execGit(cwd, ["fetch", "--quiet"], {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}
