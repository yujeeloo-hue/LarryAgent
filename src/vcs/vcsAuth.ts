/**
 * VCS (git/svn) credential prompting — turns hard auth failures into an
 * interactive ask + save flow.
 *
 * Flow (mirrors the tool-approval request/respond pattern):
 *  1. A VCS command fails with an auth error (execSvn / pushToRemote catch).
 *  2. `requestVcsCredentials` resolves credentials, consulting in order:
 *     the in-memory session cache → the encrypted store → the renderer
 *     (via the `vcs:authRequest` broadcast + `vcs:authRespond` IPC round-trip).
 *  3. The caller retries with `buildGitAuthEnv` / `buildSvnAuthArgs` —
 *     credentials never appear in argv logs (git uses env-only config
 *     injection; svn argv is not logged anywhere).
 *  4. On "remember", credentials persist via the same encrypted store as
 *     LLM API keys (Electron safeStorage → DPAPI/Keychain).
 *
 * Pure/injectable so node --test can cover it without Electron or a
 * renderer: the broadcast sink and the store cipher are injectable.
 */
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
  /** "git" | "svn" — drives the dialog wording. */
  vcs: "git" | "svn";
  /** Remote URL or host when known (git push), else the repo root. */
  context: string;
  /** What the user was doing when auth failed (Annotate / Push / …). */
  operation: string;
  /** Last error detail, shown small under the inputs. */
  detail?: string | undefined;
  /** Username prefilled when we had one but the password was rejected. */
  defaultUsername?: string | undefined;
};

export type VcsAuthResponse = {
  requestId: string;
  /** null when the user dismissed the dialog — abort, do not retry. */
  credentials: VcsCredentials | null;
  remember: boolean;
};

/** Broadcast sink — main wires this to BrowserWindow webContents.send. */
export type VcsAuthBroadcast = (payload: VcsAuthRequestPayload) => void;

const VCS_CREDENTIAL_PROVIDER_PREFIX = "vcs-auth:";

// ---------------------------------------------------------------------------
// Auth-failure detection
// ---------------------------------------------------------------------------

/**
 * True when a git/svn stderr describes a missing-or-rejected credential
 * (as opposed to a network outage or a plain permission problem).
 */
export function isVcsAuthFailure(message: string): boolean {
  const m = message.toLowerCase();
  // git: could not read Username for 'https://…': terminal prompts disabled
  if (
    m.includes("terminal prompts disabled") ||
    m.includes("could not read username") ||
    m.includes("authentication failed") ||
    m.includes("terminal prompts are disabled")
  ) {
    return true;
  }
  // git http: 401/403 against an https remote
  if (/http 40[13]/.test(m)) return true;
  // git: remote: HTTP Basic: Access denied (GitLab wording)
  if (m.includes("access denied") && m.includes("http basic")) return true;
  // git: fatal: Authentication failed for 'https://…'
  if (m.includes("authentication failed for")) return true;
  // git credential helper failure wording
  if (m.includes("could not obtain")) return true;
  // svn: E170001 (auth failed), E215004 (no more credentials), E175002
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

// ---------------------------------------------------------------------------
// Injectable broadcast sink (main registers the real one)
// ---------------------------------------------------------------------------

let broadcastSink: VcsAuthBroadcast | null = null;

/**
 * Wire the renderer broadcast (main) or clear it (tests). When null,
 * asks resolve null immediately instead of waiting on a renderer.
 */
export function setVcsAuthBroadcastSink(
  sink: VcsAuthBroadcast | null,
): void {
  broadcastSink = sink;
}

let responseWaiterCount = 0;

/**
 * Resolve the next auth response for `requestId`. The renderer answers via
 * the `vcs:authRespond` IPC handler, which routes here. Returns null when
 * no waiter is pending (stale/dupe response) — the handler reports that.
 */
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

/** How long the renderer dialog may stay open before we give up. */
const AUTH_PROMPT_TIMEOUT_MS = 10 * 60_000;

let authTimeoutMs = AUTH_PROMPT_TIMEOUT_MS;

/** Test hook: shrink the dialog timeout so timeout paths are testable. */
export function configureVcsAuthTimeoutForTests(ms: number): void {
  authTimeoutMs = ms;
}

// ---------------------------------------------------------------------------
// In-memory session cache (never persisted unless "remember")
// ---------------------------------------------------------------------------

/** cacheKey → credentials (session-lifetime; cleared on app quit). */
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

/** Test hook: wipe the in-memory cache between cases. */
export function resetSessionVcsCredentialsForTests(): void {
  sessionCredentials.clear();
}

// ---------------------------------------------------------------------------
// Store keys — username + password share one "user\0pass" payload under a
// provider id namespaced apart from LLM keys (llm-api-keys.json).
// ---------------------------------------------------------------------------

function storeProviderId(key: string): string {
  return `${VCS_CREDENTIAL_PROVIDER_PREFIX}${key}`;
}

/** Serialize credentials for the encrypted store. */
export function encodeVcsCredentials(c: VcsCredentials): string {
  return `${c.username}\u0000${c.password}`;
}

/** Inverse of {@link encodeVcsCredentials}; null when malformed. */
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

// ---------------------------------------------------------------------------
// The ask: cache → store → renderer dialog
// ---------------------------------------------------------------------------

let sequence = 0;

export type AskVcsCredentialsOptions = {
  vcs: "git" | "svn";
  operation: string;
  context: string;
  detail?: string | undefined;
  /** Username to prefill (retry after a rejected password). */
  defaultUsername?: string | undefined;
  /** Store/cache key — defaults to `vcs`+`context`. */
  cacheKey?: string | undefined;
};

/**
 * Resolve credentials for a failed operation. Never throws — a dismissed
 * dialog or a timeout both resolve null (caller reports the original error).
 */
export async function askVcsCredentials(
  opts: AskVcsCredentialsOptions,
): Promise<VcsCredentials | null> {
  const key = opts.cacheKey ?? `${opts.vcs}:${opts.context}`;
  const cached = sessionCredentials.get(key);
  if (cached) return cached;
  const stored = await readStoredVcsCredentials(key).catch(() => null);
  if (stored) return stored;

  if (!broadcastSink) return null; // no renderer attached (tests, tooling)

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

// ---------------------------------------------------------------------------
// Credential injection — builders only; argv/env stay out of logs
// ---------------------------------------------------------------------------

/**
 * git: credentials enter via env-only config injection (GIT_CONFIG_COUNT),
 * which sets `http.extraHeader` per remote URL. This avoids argv exposure
 * and never touches the repo/user config files. Terminal prompts stay
 * disabled — retries fail fast instead of hanging on an invisible prompt.
 */
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

/**
 * svn: `--username/--password --no-auth-cache` argv flags (svn has no env
 * injection; argv is never logged by this app). `--non-interactive` stays
 * in the base argv so a rejected password fails fast, not hangs.
 */
export function buildSvnAuthArgs(credentials: VcsCredentials): string[] {
  return [
    "--username",
    credentials.username,
    "--password",
    credentials.password,
    "--no-auth-cache",
  ];
}

// ---------------------------------------------------------------------------
// Remote URL lookup (git) — for the dialog context and the header match
// ---------------------------------------------------------------------------

/** Best-effort remote URL for the branch's upstream (falls back ""). */
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
