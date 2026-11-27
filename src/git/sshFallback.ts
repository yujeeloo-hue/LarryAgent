import { execFile } from "node:child_process";

export type HttpsRemoteInfo = {
  host: string;
  port: number | null;
};

export function parseHttpsGitRemote(url: string): HttpsRemoteInfo | null {
  const m = /^https?:\/\/(?:[^@/\s]+@)?([^/:?\s]+)(?::(\d+))?[/?#]/i.exec(
    url.trim(),
  );
  const host = m?.[1];
  if (!host) return null;
  return { host, port: m[2] ? Number(m[2]) : null };
}

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

export function isSshRemoteUrl(url: string): boolean {
  const u = url.trim();
  if (/^ssh:\/\//i.test(u)) return true;
  if (/^https?:\/\//i.test(u)) return false;
  return /^[^/@\s]+@[^/\s]+:[^/]/.test(u);
}

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
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        void err;
      },
    );
  });

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
  | { status: "unavailable" }
  | { status: "failed"; message: string };

export type SshFallbackPush = (
  env: Record<string, string>,
) => Promise<{ stdout: string; stderr: string }>;

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
