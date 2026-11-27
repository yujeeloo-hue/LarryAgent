import { withLlmUserAgent } from "./userAgent.js";
import { normalizeLlmBaseUrl, providerApiEndpoint, stripModelEndpoint } from "./apiProtocol.js";


export function isLocalLlmBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export type ProbeModelsResult =
  | { ok: true; models: string[]; decisionModels: string[] }
  | {
      ok: false;
      reason: string;
    };

function normalizeBaseUrl(baseUrl: string): string | null {
  const trimmed = normalizeLlmBaseUrl(baseUrl);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return stripModelEndpoint(trimmed);
  } catch {
    return null;
  }
}

function hasVersionSuffix(baseUrl: string): boolean {
  try { return /\/v\d+\/*$/.test(new URL(baseUrl).pathname); }
  catch { return false; }
}

function isDecisionModelEntry(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const architecture = (item as { architecture?: unknown }).architecture;
  if (!architecture || typeof architecture !== "object") return false;
  const { output_modalities: outputs, modality } = architecture as { output_modalities?: unknown; modality?: unknown };
  if (Array.isArray(outputs) && outputs.includes("decisions")) return true;
  return typeof modality === "string" && /->\s*decisions\b/.test(modality);
}

function parseDecisionModelIds(payload: unknown): string[] {
  const items = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const ids = items
    .filter(isDecisionModelEntry)
    .map((item) => (item as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
  return Array.from(new Set(ids)).sort();
}

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
      return { ok: false, reason: `http_${result.status}` };
    }
    if (result.payload === null) {
      lastReason = "bad_payload";
      continue;
    }
    const models = parseModelIds(result.payload);
    if (models.length > 0) return { ok: true, models, decisionModels: parseDecisionModelIds(result.payload) };
    lastReason = "no_models";
  }
  return { ok: false, reason: lastReason };
}

export type UsableProviderInputs = {
  providers: ReadonlyArray<{ id: string; baseUrl: string }>;
  hasKeyInStore: (providerId: string) => Promise<boolean>;
  envApiKey: string | null;
};

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
