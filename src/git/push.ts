import { execGit, GitCommandError } from "./execGit.js";
import {
  askVcsCredentials,
  buildGitAuthEnv,
  gitRemoteUrl,
  isVcsAuthFailure,
} from "../vcs/vcsAuth.js";
import { isSshRemoteUrl, pushWithSshFallback } from "./sshFallback.js";

const PUSH_TIMEOUT_MS = 120_000;

export type GitPushResult =
  | { ok: true; output: string }
  | { ok: false; message: string };

function withSshHint(message: string, remoteUrl: string): string {
  const m = message.toLowerCase();
  const hint = m.includes("host key verification failed")
    ? " — run `ssh -T` against the remote host once in Terminal to accept its host key"
    : isSshRemoteUrl(remoteUrl) && !m.includes("not a git repository")
      ? " — SSH key auth failed; check `ssh-add -l` / ~/.ssh/config, or verify with `ssh -T` in Terminal"
      : "";
  return hint ? `${message}${hint}` : message;
}

export async function pushToRemote(cwd: string): Promise<GitPushResult> {
  let firstError = "";
  try {
    const res = await execGit(cwd, ["push"], {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: PUSH_TIMEOUT_MS,
    });
    const output = `${res.stdout}${res.stderr}`.trim();
    return { ok: true, output };
  } catch (err) {
    if (!(err instanceof GitCommandError) || !isVcsAuthFailure(err.message)) {
      if (err instanceof GitCommandError) {
        return { ok: false, message: err.stderr.trim() || err.message };
      }
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    firstError = err.stderr.trim() || err.message;
  }

  let remoteUrl = "";
  try {
    remoteUrl = await gitRemoteUrl(cwd);
  } catch {
    remoteUrl = "";
  }

  const ssh = await pushWithSshFallback(remoteUrl, (env) =>
    execGit(cwd, ["push"], { env, timeoutMs: PUSH_TIMEOUT_MS }),
  );
  if (ssh.status === "pushed") {
    return { ok: true, output: `${ssh.output}\n(push via SSH key)` };
  }
  if (ssh.status === "failed" && !isVcsAuthFailure(ssh.message)) {
    return { ok: false, message: ssh.message };
  }

  if (isSshRemoteUrl(remoteUrl)) {
    return { ok: false, message: withSshHint(firstError, remoteUrl) };
  }

  let lastError = firstError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const credentials = await askVcsCredentials({
      vcs: "git",
      operation: "Push",
      context: remoteUrl || cwd,
      detail: lastError,
    });
    if (!credentials) break;
    try {
      const res = await execGit(cwd, ["push"], {
        env: buildGitAuthEnv(remoteUrl || "*", credentials),
        timeoutMs: PUSH_TIMEOUT_MS,
      });
      const output = `${res.stdout}${res.stderr}`.trim();
      return { ok: true, output };
    } catch (err) {
      if (err instanceof GitCommandError) {
        lastError = err.stderr.trim() || err.message;
        if (!isVcsAuthFailure(lastError)) {
          return { ok: false, message: lastError };
        }
      } else {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  return { ok: false, message: lastError };
}

