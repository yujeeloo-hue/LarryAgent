import { execGit } from "../git/execGit.js";
import {
  readApiKeyFromStore,
  writeApiKeyToStore,
} from "../llm/credentials.js";

export type VcsCredentials = {
  username: string;
  password: string;
};

export type VcsAuthRequestPayload = {
  requestId: string;
  vcs: "git" | "svn";
  context: string;
  operation: string;
  detail?: string | undefined;
  defaultUsername?: string | undefined;
};

export type VcsAuthResponse = {
  requestId: string;
  credentials: VcsCredentials | null;
  remember: boolean;
};

export type VcsAuthBroadcast = (payload: VcsAuthRequestPayload) => void;

const VCS_CREDENTIAL_PROVIDER_PREFIX = "vcs-auth:";


export function isVcsAuthFailure(message: string): boolean {
  const m = message.toLowerCase();
  if (
    m.includes("terminal prompts disabled") ||
    m.includes("could not read username") ||
    m.includes("authentication failed") ||
    m.includes("terminal prompts are disabled")
  ) {
    return true;
  }
  if (/http 40[13]/.test(m)) return true;
  if (m.includes("access denied") && m.includes("http basic")) return true;
  if (m.includes("authentication failed for")) return true;
  if (m.includes("could not obtain")) return true;
  if (/e170001|e215004|e175002|e170013/.test(m)) return true;
  if (
    m.includes("password") &&
    (m.includes("incorrect") || m.includes("required") || m.includes("denied"))
  ) {
    return true;
  }
  if (m.includes("username") && m.includes("required")) return true;
  return false;
}


let broadcastSink: VcsAuthBroadcast | null = null;

export function setVcsAuthBroadcastSink(
  sink: VcsAuthBroadcast | null,
): void {
  broadcastSink = sink;
}

let responseWaiterCount = 0;

export function resolveVcsAuthResponse(
  response: VcsAuthResponse,
): boolean {
  const waiter = pendingWaiters.get(response.requestId);
  if (!waiter) return false;
  pendingWaiters.delete(response.requestId);
  waiter(response);
  return true;
}

type Waiter = (response: VcsAuthResponse) => void;
const pendingWaiters = new Map<string, Waiter>();

const AUTH_PROMPT_TIMEOUT_MS = 10 * 60_000;

let authTimeoutMs = AUTH_PROMPT_TIMEOUT_MS;

export function configureVcsAuthTimeoutForTests(ms: number): void {
  authTimeoutMs = ms;
}


const sessionCredentials = new Map<string, VcsCredentials>();

export function cacheSessionVcsCredentials(
  key: string,
  credentials: VcsCredentials,
): void {
  sessionCredentials.set(key, credentials);
}

export function clearSessionVcsCredentials(key: string): void {
  sessionCredentials.delete(key);
}

export function resetSessionVcsCredentialsForTests(): void {
  sessionCredentials.clear();
}


function storeProviderId(key: string): string {
  return `${VCS_CREDENTIAL_PROVIDER_PREFIX}${key}`;
}

export function encodeVcsCredentials(c: VcsCredentials): string {
  return `${c.username}\u0000${c.password}`;
}

export function decodeVcsCredentials(payload: string): VcsCredentials | null {
  const sep = payload.indexOf("\u0000");
  if (sep <= 0) return null;
  const username = payload.slice(0, sep);
  const password = payload.slice(sep + 1);
  if (!username || sep === payload.length - 1) return null;
  return { username, password };
}

export async function readStoredVcsCredentials(
  key: string,
): Promise<VcsCredentials | null> {
  const raw = await readApiKeyFromStore(storeProviderId(key)).catch(() => null);
  if (!raw) return null;
  return decodeVcsCredentials(raw);
}

export async function writeStoredVcsCredentials(
  key: string,
  credentials: VcsCredentials,
): Promise<void> {
  await writeApiKeyToStore(
    encodeVcsCredentials(credentials),
    storeProviderId(key),
  );
}


let sequence = 0;

export type AskVcsCredentialsOptions = {
  vcs: "git" | "svn";
  operation: string;
  context: string;
  detail?: string | undefined;
  defaultUsername?: string | undefined;
  cacheKey?: string | undefined;
};

export async function askVcsCredentials(
  opts: AskVcsCredentialsOptions,
): Promise<VcsCredentials | null> {
  const key = opts.cacheKey ?? `${opts.vcs}:${opts.context}`;
  const cached = sessionCredentials.get(key);
  if (cached) return cached;
  const stored = await readStoredVcsCredentials(key).catch(() => null);
  if (stored) return stored;

  if (!broadcastSink) return null;

  const requestId = `vcs-auth-${Date.now()}-${sequence++}`;
  const waiter = new Promise<VcsAuthResponse | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingWaiters.delete(requestId);
      resolve(null);
    }, authTimeoutMs);
    pendingWaiters.set(requestId, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
  broadcastSink({
    requestId,
    vcs: opts.vcs,
    context: opts.context,
    operation: opts.operation,
    detail: opts.detail,
    defaultUsername: opts.defaultUsername,
  });
  const response = await waiter;
  if (!response || !response.credentials) return null;
  const { username, password } = response.credentials;
  if (!username.trim() || !password) return null;
  const credentials = { username: username.trim(), password };
  if (response.remember) {
    await writeStoredVcsCredentials(key, credentials).catch(() => {});
  } else {
    cacheSessionVcsCredentials(key, credentials);
  }
  return credentials;
}


export function buildGitAuthEnv(
  remoteUrl: string,
  credentials: VcsCredentials,
): Record<string, string> {
  const basic = Buffer.from(
    `${credentials.username}:${credentials.password}`,
    "utf8",
  ).toString("base64");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${remoteUrl}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export function buildSvnAuthArgs(credentials: VcsCredentials): string[] {
  return [
    "--username",
    credentials.username,
    "--password",
    credentials.password,
    "--no-auth-cache",
  ];
}


export async function gitRemoteUrl(cwd: string): Promise<string> {
  try {
    const remote = await execGit(cwd, ["remote"]);
    const first = remote.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (!first) return "";
    const url = await execGit(cwd, ["remote", "get-url", first]);
    return url.stdout.trim();
  } catch {
    return "";
  }
}
