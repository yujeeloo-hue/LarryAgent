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

const CONFLICT_STATUS_RE = /^(?:DD|AU|UD|UA|DU|UU|AA)\s/;
const ALREADY_UP_TO_DATE_RE = /already up[- ]to[- ]date/i;

export async function mergeInProgress(cwd: string): Promise<boolean> {
  try {
    await execGit(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function collectConflictPaths(cwd: string): Promise<string[]> {
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

function withSshHint(message: string, remoteUrl: string): string {
  const m = message.toLowerCase();
  const hint = m.includes("host key verification failed")
    ? " — run `ssh -T` against the remote host once in Terminal to accept its host key"
    : isSshRemoteUrl(remoteUrl) && !m.includes("not a git repository")
      ? " — SSH key auth failed; check `ssh-add -l` / ~/.ssh/config, or verify with `ssh -T` in Terminal"
      : "";
  return hint ? `${message}${hint}` : message;
}

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

  let remoteUrl = "";
  try {
    remoteUrl = await gitRemoteUrl(cwd);
  } catch {
    remoteUrl = "";
  }

  if (isSshRemoteUrl(remoteUrl)) {
    return { ok: false, message: withSshHint(firstClassified.message, remoteUrl) };
  }

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
