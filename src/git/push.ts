/**
 * `git push` for the Dev Mode Push button.
 *
 * GIT_TERMINAL_PROMPT=0 keeps a credential-less HTTPS remote from hanging
 * the IPC on an invisible prompt (keychain/ssh-agent credentials still
 * work — only terminal asks fail fast). When that fail-fast error is an
 * auth failure we first retry over SSH when this machine has a working
 * key for the remote host (env-only insteadOf rewrite, see sshFallback) —
 * a configured SSH key should never ask the user for credentials. Only
 * when SSH can't help do we ask once (renderer dialog, vcsAuth module),
 * then retry with the credentials injected as env-only config
 * (GIT_CONFIG_COUNT / http.extraheader) — no argv, no config-file edits.
 */
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

/** Actionable hints appended to push failures that credentials can't fix. */
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

  // Auth failure. Resolve the remote once — it drives every recovery path.
  let remoteUrl = "";
  try {
    remoteUrl = await gitRemoteUrl(cwd);
  } catch {
    remoteUrl = "";
  }

  // A working local SSH key should push without any prompt.
  const ssh = await pushWithSshFallback(remoteUrl, (env) =>
    execGit(cwd, ["push"], { env, timeoutMs: PUSH_TIMEOUT_MS }),
  );
  if (ssh.status === "pushed") {
    return { ok: true, output: `${ssh.output}\n(push via SSH key)` };
  }
  if (ssh.status === "failed" && !isVcsAuthFailure(ssh.message)) {
    // SSH got in, but the push itself was refused (e.g. non-fast-forward).
    return { ok: false, message: ssh.message };
  }

  // SSH remotes have no username/password — a credential dialog is noise.
  if (isSshRemoteUrl(remoteUrl)) {
    return { ok: false, message: withSshHint(firstError, remoteUrl) };
  }

  // HTTPS remote without SSH access → ask + retry (a rejected password
  // re-asks, bounded).
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

