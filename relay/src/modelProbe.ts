/**
 * Server-side OpenAI-compatible gateway model probe for the Console Token Hub.
 *
 * Ported from the desktop wizard's `src/llm/providerSetup.ts` so both entry
 * points share one detection behaviour (path retry order, payload shapes,
 * reason codes). The hub — not the browser — performs the request: most
 * gateways send no CORS headers for `/models`, and the API key is already
 * held server-side.
 *
 * SSRF posture (this runs on the relay host, so an admin-supplied URL is an
 * outbound request from the server):
 * - only http(s), never follow redirects (`redirect: "manual"`; any 3xx fails)
 * - hard-refuse link-local / cloud-metadata / multicast / reserved ranges and
 *   the well-known metadata hostnames — a detection call must never reach the
 *   host's own credential endpoints
 * - loopback and private (RFC1918 / ULA) ranges stay reachable on purpose: the
 *   console session token belongs to the relay's own operator, and a
 *   self-hosted relay is expected to probe its local ollama / LM Studio. The
 *   same host would also be reachable to that operator directly, so allowing
 *   it adds no exposure — metadata and link-local are the ranges that do.
 * - per-attempt timeout plus an overall deadline, so a black-holed host cannot
 *   pin a console request open
 * - the API key is used only in the `Authorization` header and never appears
 *   in a returned reason, log line, or audit detail
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizeProviderBaseUrl } from "./providerApiOptions.js";

/** Some gateways reject the default `User-Agent: node` (GLM answers 429/1305). */
const PROBE_USER_AGENT = "JellyBotRelay/models-probe";
const PER_ATTEMPT_TIMEOUT_MS = 8_000;
/** Total budget across every candidate URL of one probe. */
const DEFAULT_DEADLINE_MS = 20_000;
/** `/models` catalogues are small; a huge body is not something we will parse. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ProbeModelsResult =
  | { ok: true; models: string[] }
  | {
      ok: false;
      /**
       * "invalid_url" | "missing_key" | "network" | "bad_payload" |
       * "no_models" | "blocked_target" | `http_<status>`
       */
      reason: string;
    };

export type ProbeModelsOptions = {
  /** Overall budget for all candidate URLs of one probe. */
  deadlineMs?: number;
  /** Injectable for tests; defaults to `node:dns/promises`.lookup. */
  resolveAddresses?: (host: string) => Promise<string[]>;
};

/** Trimmed (no trailing slash) absolute http(s) URL, or null when invalid. */
function normalizeBaseUrl(baseUrl: string): string | null {
  const trimmed = normalizeProviderBaseUrl(baseUrl);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Return the trimmed input — URL.toString() always re-adds a trailing
    // slash for bare origins, which would produce `//models` joins.
    const queryAt = trimmed.search(/[?#]/);
    const path = queryAt < 0 ? trimmed : trimmed.slice(0, queryAt);
    const query = queryAt < 0 ? "" : trimmed.slice(queryAt);
    return path.replace(/\/(?:responses|chat\/completions)\/*$/i, "").replace(/\/+$/, "") + query;
  } catch {
    return null;
  }
}

/** Local OpenAI-compatible servers often need no real API key. */
export function isLocalLlmBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Hostnames that always mean "the machine's own credential endpoint". */
const BLOCKED_HOSTNAMES = [
  "metadata",
  "metadata.google.internal",
  "metadata.tencentyun.com",
  "instance-data",
];

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → refuse
  }
  const [a, b] = parts as [number, number, number, number];
  // Allowed on purpose: 127/8 loopback, 10/8, 172.16/12, 192.168/16 (see header).
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    (a === 100 && b >= 64 && b <= 127) || // CGNAT incl. Alibaba metadata 100.100.100.200
    (a === 169 && b === 254) || // link-local incl. AWS/GCP metadata
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF, 192.0.2.0/24 doc
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || // documentation
    (a === 203 && b === 0) || // documentation
    a >= 224 // multicast + reserved
  );
}

/**
 * Expand an IPv6 string into its eight 16-bit groups.
 *
 * Text forms matter here: the WHATWG URL parser rewrites
 * `::ffff:169.254.169.254` to the canonical `::ffff:a9fe:a9fe`, so any check
 * that pattern-matches the dotted-quad spelling silently lets cloud-metadata
 * addresses through. Working from group values instead of strings covers
 * mapped, compatibility and compressed forms alike.
 */
function parseIpv6Groups(value: string): number[] | null {
  const text = value.toLowerCase().split("%")[0] ?? "";
  if (!text) return null;
  const doubleColon = text.indexOf("::");
  const headText = doubleColon < 0 ? text : text.slice(0, doubleColon);
  const tailText = doubleColon < 0 ? "" : text.slice(doubleColon + 2);
  const toGroups = (parts: string[], allowQuad: boolean): number[] | null => {
    const out: number[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (part.includes(".")) {
        // A trailing dotted quad occupies the last two groups.
        if (!allowQuad || index !== parts.length - 1) return null;
        const octets = part.split(".").map((n) => Number(n));
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null;
        }
        const [a, b, c, d] = octets as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = toGroups(headText ? headText.split(":") : [], doubleColon < 0);
  const tail = toGroups(tailText ? tailText.split(":") : [], true);
  if (!head || !tail) return null;
  if (doubleColon < 0) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function isBlockedIpv6(ip: string): boolean {
  const groups = parseIpv6Groups(ip);
  if (!groups) return true; // unparseable literal — refuse rather than guess
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  const isZero = (n: number) => n === 0;
  if (isZero(g0) && isZero(g1) && isZero(g2) && isZero(g3) && isZero(g4) && isZero(g5)) {
    if (g6 === 0 && g7 === 1) return false; // ::1 loopback — allowed, see header
    if (g6 === 0 && g7 === 0) return true; // :: unspecified (any-interface)
    // IPv4-compatible ::a.b.c.d — judge the embedded v4.
    return isBlockedIpv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if (isZero(g0) && isZero(g1) && isZero(g2) && isZero(g3) && isZero(g4) && g5 === 0xffff) {
    // IPv4-mapped, in either the dotted or the canonical hex spelling.
    return isBlockedIpv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if (g0 >= 0xff00) return true; // multicast ff00::/12 and reserved
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  // fc00::/7 ULA and everything public stay allowed (see header).
  return false;
}

/**
 * True when an address — a literal or one DNS resolved — must not be contacted.
 * Anything that cannot be classified is refused (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const value = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(value);
  if (kind === 4) return isBlockedIpv4(value);
  if (kind === 6) return isBlockedIpv6(value);
  return true;
}

async function defaultResolveAddresses(host: string): Promise<string[]> {
  const withoutBrackets = host.replace(/^\[|\]$/g, "");
  if (isIP(withoutBrackets)) return [withoutBrackets];
  // Literal-shaped but not a valid address (e.g. a mangled IPv6 form): hand it
  // to the classifier so it fails closed instead of falling through to DNS.
  if (host.startsWith("[") || withoutBrackets.includes(":")) return [withoutBrackets];
  if (/^\d+(\.\d+){0,3}$/.test(withoutBrackets)) return [withoutBrackets];
  if (withoutBrackets === "localhost") return ["127.0.0.1", "::1"];
  const records = await lookup(withoutBrackets, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Shared pre-flight target guard for relay-side gateway probes: refuse
 * metadata hostnames and blocked-range destinations before any outbound
 * request. Unresolvable hosts pass (the fetch itself reports the network
 * failure), mirroring probeLlmModels.
 */
export async function probeTargetBlocked(
  baseUrl: string,
  resolve: (host: string) => Promise<string[]> = defaultResolveAddresses,
): Promise<boolean> {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (BLOCKED_HOSTNAMES.includes(hostname) || hostname.endsWith(".internal")) return true;
  try {
    const addresses = await resolve(hostname);
    if (addresses.some((address) => isBlockedAddress(address))) return true;
  } catch {
    // Unresolvable: let fetch surface the error like the desktop does.
  }
  return false;
}

/** Base already ends with a version segment (/v1, /v2, …) — appending one would duplicate it. */
function hasVersionSuffix(baseUrl: string): boolean {
  return /\/v\d+\/*$/.test(new URL(baseUrl).pathname);
}

/**
 * OpenAI-compatible `/models` payload: `{ data: [{ id }] }`. Some gateways
 * answer with a bare array; items may also be plain strings. Unknown shapes
 * simply yield an empty list (caller reports `no_models`).
 */
function parseModelIds(payload: unknown): string[] {
  let items: unknown[] | null = null;
  if (Array.isArray(payload)) {
    items = payload;
  } else if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    items = (payload as { data: unknown[] }).data;
  }
  const ids: string[] = [];
  for (const item of items ?? []) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id) ids.push(id);
    } else if (item && typeof item === "object") {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return Array.from(new Set(ids)).sort();
}

async function fetchModels(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{ status: number; payload: unknown } | { error: true }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}`, "User-Agent": PROBE_USER_AGENT }
        : { "User-Agent": PROBE_USER_AGENT },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    // 3xx never helps here: a gateway that needs a redirect is not the one the
    // user named, and following it would hand the guard a new target.
    if (response.status >= 300 && response.status < 400) return { status: response.status, payload: null };
    if (!response.ok) return { status: response.status, payload: null };
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_RESPONSE_BYTES) return { status: response.status, payload: null };
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return { status: response.status, payload: null };
    try {
      return { status: response.status, payload: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, payload: null };
    }
  } catch {
    return { error: true as const };
  }
}

/**
 * Canonical model-list URLs for gateways whose API is not `{host}/v1`.
 *
 * OpenRouter's catalogue is `https://openrouter.ai/api/v1/models`. The site
 * root answers `GET /models` and `GET /v1/models` with HTML 200, so the
 * generic retry never reaches the API.
 *
 * OpenCode Zen is `https://opencode.ai/zen/v1/models` and OpenCode Go is
 * `https://opencode.ai/zen/go/v1/models`. A path that already names one
 * product stays on that catalogue. A bare host tries Zen, then Go — a Go
 * key 401s on Zen, and that auth error is not fatal while another
 * catalogue remains.
 */
function platformModelUrls(base: string): string[] {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase();
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
    return ["https://openrouter.ai/api/v1/models"];
  }
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/zen/go" || path.startsWith("/zen/go/")) {
      return ["https://opencode.ai/zen/go/v1/models"];
    }
    if (path === "/zen" || path.startsWith("/zen/")) {
      return ["https://opencode.ai/zen/v1/models"];
    }
    return [
      "https://opencode.ai/zen/v1/models",
      "https://opencode.ai/zen/go/v1/models",
    ];
  }
  return [];
}

function modelProbeUrls(base: string): { urls: string[]; extraFrom: number } {
  const endpoint = (path: string): string => {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
    return url.toString();
  };
  const urls = [endpoint("models")];
  if (!hasVersionSuffix(base)) urls.push(endpoint("v1/models"));
  const extraFrom = urls.length;
  for (const extra of platformModelUrls(base)) {
    if (!urls.includes(extra)) urls.push(extra);
  }
  return { urls, extraFrom };
}

/**
 * Enumerate chat models on an OpenAI-compatible gateway.
 *
 * Attempts `{base}/models`; when the route is missing (404/405) or the
 * payload is unusable and the base URL carries no version segment, retries
 * `{base}/v1/models` — users paste DeepSeek-style hosts without `/v1`, and
 * local servers (Ollama) only serve the OpenAI-compatible path.
 * OpenRouter and OpenCode then fall through to their canonical catalogues
 * (see `platformModelUrls`). Auth/network failures on the caller's own URL
 * fail fast. A 401/403 on a platform fallback continues while another
 * catalogue remains (OpenCode Go keys are rejected by Zen).
 */
export async function probeLlmModels(
  input: { baseUrl: string; apiKey?: string },
  options?: ProbeModelsOptions,
): Promise<ProbeModelsResult> {
  const base = normalizeBaseUrl(input.baseUrl ?? "");
  if (!base) return { ok: false, reason: "invalid_url" };
  const apiKey = (input.apiKey ?? "").trim();
  if (!apiKey && !isLocalLlmBaseUrl(base)) {
    return { ok: false, reason: "missing_key" };
  }

  let hostname = "";
  try {
    hostname = new URL(base).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (BLOCKED_HOSTNAMES.includes(hostname) || hostname.endsWith(".internal")) {
    return { ok: false, reason: "blocked_target" };
  }
  const resolve = options?.resolveAddresses ?? defaultResolveAddresses;
  try {
    const addresses = await resolve(hostname);
    if (addresses.some((address) => isBlockedAddress(address))) {
      return { ok: false, reason: "blocked_target" };
    }
  } catch {
    // Unresolvable host: let fetch report it as `network` like the desktop does.
  }

  const deadlineMs = options?.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const startedAt = Date.now();
  const { urls, extraFrom } = modelProbeUrls(base);
  let lastReason = "network";
  for (let i = 0; i < urls.length; i++) {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      lastReason = lastReason === "network" ? "network" : lastReason;
      break;
    }
    const url = urls[i]!;
    const result = await fetchModels(url, apiKey, Math.min(PER_ATTEMPT_TIMEOUT_MS, remaining));
    if ("error" in result) {
      // Host unreachable / timeout — later path variants share the host,
      // but a platform catalogue on the same registrable domain can still
      // be up. Only abort when this was the caller's own URL.
      if (i < extraFrom) return { ok: false, reason: "network" };
      lastReason = "network";
      continue;
    }
    const platformFallback = i >= extraFrom;
    const more = i < urls.length - 1;
    if (result.status >= 300 && result.status < 400) {
      return { ok: false, reason: "blocked_target" };
    }
    if (result.status === 404 || result.status === 405) {
      lastReason = `http_${result.status}`;
      continue;
    }
    if (platformFallback && more && (result.status === 401 || result.status === 403)) {
      lastReason = `http_${result.status}`;
      continue;
    }
    if (result.status !== 200) {
      // 401/403 (bad key), 429, 5xx — retrying another path cannot help.
      return { ok: false, reason: `http_${result.status}` };
    }
    if (result.payload === null) {
      lastReason = "bad_payload";
      continue;
    }
    const models = parseModelIds(result.payload);
    if (models.length > 0) return { ok: true, models };
    lastReason = "no_models";
  }
  return { ok: false, reason: lastReason };
}

/**
 * Single source for the hub's "Vision" badge: the gateway's `/models` payload
 * rarely declares modality, so the model id is the only signal available at
 * detection time. The console lets the user override it per provider
 * (`multimodalSource: "manual"`).
 */
const MULTIMODAL_MODEL =
  /(^|[-_/])(gpt-4o|gpt-5|vision|vl|pixtral|gemini|claude-3|claude-4|kimi|glm-4v|qwen-vl)([-_/.:]|$)/i;

export function modelSupportsVision(modelId: string): boolean {
  return MULTIMODAL_MODEL.test(modelId);
}
