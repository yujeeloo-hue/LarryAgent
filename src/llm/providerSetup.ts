import { withLlmUserAgent } from "./userAgent.js";
import { normalizeLlmBaseUrl, providerApiEndpoint, stripModelEndpoint } from "./apiProtocol.js";

/**
 * Provider setup wizard backend: enumerate models on an OpenAI-compatible
 * gateway and decide whether the app already has a usable LLM provider.
 *
 * Both power the first-run wizard (Settings "+" / startup onboarding /
 * send-failure error card). Requests run in the main process — no renderer
 * CORS concerns — and mirror llm:checkHealth's request conventions
 * (explicit User-Agent, 8s timeout).
 */

/** Local OpenAI-compatible servers often need no real API key. */
export function isLocalLlmBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export type ProbeModelsResult =
  | { ok: true; models: string[] }
  | {
      ok: false;
      /**
       * "invalid_url" | "missing_key" | "network" | "bad_payload" |
       * "no_models" | `http_<status>`
       */
      reason: string;
    };

/** Trimmed (no trailing slash) absolute http(s) URL, or null when invalid. */
function normalizeBaseUrl(baseUrl: string): string | null {
  const trimmed = normalizeLlmBaseUrl(baseUrl);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Return the trimmed input — URL.toString() always re-adds a trailing
    // slash for bare origins, which would produce `//models` joins.
    return stripModelEndpoint(trimmed);
  } catch {
    return null;
  }
}

/** Base already ends with a version segment (/v1, /v2, …) — appending one would duplicate it. */
function hasVersionSuffix(baseUrl: string): boolean {
  try { return /\/v\d+\/*$/.test(new URL(baseUrl).pathname); }
  catch { return false; }
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
): Promise<{ status: number; payload: unknown } | { error: true }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: withLlmUserAgent(
        apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      ),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { status: response.status, payload: null };
    try {
      return { status: response.status, payload: await response.json() };
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
  const urls = [providerApiEndpoint(base, "models")];
  if (!hasVersionSuffix(base)) urls.push(providerApiEndpoint(base, "v1/models"));
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
export async function probeLlmModels(input: {
  baseUrl: string;
  apiKey?: string;
}): Promise<ProbeModelsResult> {
  const base = normalizeBaseUrl(input.baseUrl ?? "");
  if (!base) return { ok: false, reason: "invalid_url" };
  const apiKey = (input.apiKey ?? "").trim();
  if (!apiKey && !isLocalLlmBaseUrl(base)) {
    return { ok: false, reason: "missing_key" };
  }
  const { urls, extraFrom } = modelProbeUrls(base);

  let lastReason = "network";
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const result = await fetchModels(url, apiKey);
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
    if (result.status === 404 || result.status === 405) {
      lastReason = `http_${result.status}`;
      continue;
    }
    if (
      platformFallback &&
      more &&
      (result.status === 401 || result.status === 403)
    ) {
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

export type UsableProviderInputs = {
  providers: ReadonlyArray<{ id: string; baseUrl: string }>;
  hasKeyInStore: (providerId: string) => Promise<boolean>;
  /** Resolved `.env` / process env JELLYBOT_API_KEY value, when present. */
  envApiKey: string | null;
};

/**
 * Startup onboarding gate: is any chat provider usable without the wizard?
 * Mirrors turn-time key resolution (store key → workspace .env → process
 * env), so users relying on `.env JELLYBOT_API_KEY` are not nagged.
 */
export async function hasUsableLlmProvider(
  input: UsableProviderInputs,
): Promise<boolean> {
  if ((input.envApiKey ?? "").trim()) return true;
  for (const provider of input.providers) {
    if (isLocalLlmBaseUrl(provider.baseUrl)) return true;
    if (await input.hasKeyInStore(provider.id)) return true;
  }
  return false;
}
