/**
 * SSH push fallback for HTTPS git remotes.
 *
 * When `git push` fails auth against an HTTPS remote (no keychain entry /
 * expired PAT) but this machine holds a working SSH key for the same host,
 * we retry the push over SSH via an env-only URL rewrite —
 * `url.<ssh>.insteadOf = https://<host>/` — no repo or user config edits,
 * same injection style as `buildGitAuthEnv`.
 *
 * Everything is non-interactive and fail-fast: the SSH probe runs with
 * BatchMode (a passphrase prompt can never hang the IPC), and any probe
 * failure simply hands control back to the credential-dialog flow.
 */
import { execFile } from "node:child_process";

export type HttpsRemoteInfo = {
  host: string;
  port: number | null;
};

/**
 * Parse an http(s) git remote URL into host/port. Returns null for SSH
 * (`git@host:path`, `ssh://`), local, and bare URLs — those can't be
 * helped by an HTTPS→SSH rewrite.
 */
export function parseHttpsGitRemote(url: string): HttpsRemoteInfo | null {
  const m = /^https?:\/\/(?:[^@/\s]+@)?([^/:?\s]+)(?::(\d+))?[/?#]/i.exec(
    url.trim(),
  );
  const host = m?.[1];
  if (!host) return null;
  return { host, port: m[2] ? Number(m[2]) : null };
}

/**
 * Env-only insteadOf rewrite for one git invocation:
 * `https://<host>/…` → `git@<host>:…` (scp form), or `ssh://git@<host>:<port>/`
 * when the remote carries a custom port. Null when `remoteUrl` is not
 * an http(s) remote.
 */
export function buildSshInsteadOfEnv(
  remoteUrl: string,
): Record<string, string> | null {
  const info = parseHttpsGitRemote(remoteUrl);
  if (!info) return null;
  const scheme = /^http:\/\//i.test(remoteUrl.trim()) ? "http" : "https";
  const httpBase = `${scheme}://${info.host}/`;
  const sshBase = info.port
    ? `ssh://git@${info.host}:${info.port}/`
    : `git@${info.host}:`;
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${sshBase}.insteadOf`,
    GIT_CONFIG_VALUE_0: httpBase,
  };
}

/** True for remotes reached over SSH (`git@host:path`, `ssh://…`). */
export function isSshRemoteUrl(url: string): boolean {
  const u = url.trim();
  if (/^ssh:\/\//i.test(u)) return true;
  if (/^https?:\/\//i.test(u)) return false;
  return /^[^/@\s]+@[^/\s]+:[^/]/.test(u);
}

/**
 * Success markers of `ssh -T git@<host>` on git servers:
 *   GitHub    "Hi <user>! You've successfully authenticated…"
 *   GitLab    "Welcome to GitLab, @<user>!"
 *   Bitbucket "logged in as <user>"
 */
export function sshProbeIndicatesAccess(output: string): boolean {
  return /successfully authenticated|welcome to|logged in as/i.test(output);
}

export type SshProbeResult = { stdout: string; stderr: string };

export type SshProbeRunner = (args: string[]) => Promise<SshProbeResult>;

const defaultProbeRunner: SshProbeRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      "ssh",
      args,
      { timeout: 15_000, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        // GitHub's `ssh -T` exits 1 even on success — decide on output,
        // never on the exit code.
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        void err;
      },
    );
  });

/**
 * Non-interactive SSH auth probe for a git host. Never throws; resolves
 * false when ssh is missing, the key is absent/passphrased-but-unloaded,
 * or the host simply doesn't speak git-over-SSH.
 */
export async function probeSshGitAccess(
  info: HttpsRemoteInfo,
  run: SshProbeRunner = defaultProbeRunner,
): Promise<boolean> {
  const dest = info.port
    ? `ssh://git@${info.host}:${info.port}`
    : `git@${info.host}`;
  try {
    const res = await run([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-T",
      dest,
    ]);
    return sshProbeIndicatesAccess(`${res.stdout}\n${res.stderr}`);
  } catch {
    return false;
  }
}

export type SshFallbackResult =
  | { status: "pushed"; output: string }
  /** SSH can't help (not an HTTPS remote / no working key) — try other auth. */
  | { status: "unavailable" }
  /** The SSH push itself ran and failed. */
  | { status: "failed"; message: string };

export type SshFallbackPush = (
  env: Record<string, string>,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * One SSH-retry push after an HTTPS auth failure: probe the host, then
 * push with the insteadOf rewrite when the key works. `push` throwing
 * maps to `failed` with its stderr/message.
 */
export async function pushWithSshFallback(
  remoteUrl: string,
  push: SshFallbackPush,
  run: SshProbeRunner = defaultProbeRunner,
): Promise<SshFallbackResult> {
  const env = buildSshInsteadOfEnv(remoteUrl);
  const info = parseHttpsGitRemote(remoteUrl);
  if (!env || !info) return { status: "unavailable" };
  if (!(await probeSshGitAccess(info, run))) return { status: "unavailable" };
  try {
    const res = await push(env);
    return { status: "pushed", output: `${res.stdout}${res.stderr}`.trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", message };
  }
}
