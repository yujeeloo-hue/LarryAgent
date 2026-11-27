import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizeProviderBaseUrl } from "./providerApiOptions.js";

const PROBE_USER_AGENT = "JellyBotRelay/models-probe";
const PER_ATTEMPT_TIMEOUT_MS = 8_000;
const DEFAULT_DEADLINE_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ProbeModelsResult =
  | { ok: true; models: string[] }
  | {
      ok: false;
      reason: string;
    };

export type ProbeModelsOptions = {
  deadlineMs?: number;
  resolveAddresses?: (host: string) => Promise<string[]>;
};

function normalizeBaseUrl(baseUrl: string): string | null {
  const trimmed = normalizeProviderBaseUrl(baseUrl);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const queryAt = trimmed.search(/[?#]/);
    const path = queryAt < 0 ? trimmed : trimmed.slice(0, queryAt);
    const query = queryAt < 0 ? "" : trimmed.slice(queryAt);
    return path.replace(/\/(?:responses|chat\/completions)\/*$/i, "").replace(/\/+$/, "") + query;
  } catch {
    return null;
  }
}

export function isLocalLlmBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

const BLOCKED_HOSTNAMES = [
  "metadata",
  "metadata.google.internal",
  "metadata.tencentyun.com",
  "instance-data",
];

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

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
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  const isZero = (n: number) => n === 0;
  if (isZero(g0) && isZero(g1) && isZero(g2) && isZero(g3) && isZero(g4) && isZero(g5)) {
    if (g6 === 0 && g7 === 1) return false;
    if (g6 === 0 && g7 === 0) return true;
    return isBlockedIpv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if (isZero(g0) && isZero(g1) && isZero(g2) && isZero(g3) && isZero(g4) && g5 === 0xffff) {
    return isBlockedIpv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if (g0 >= 0xff00) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  return false;
}

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
  if (host.startsWith("[") || withoutBrackets.includes(":")) return [withoutBrackets];
  if (/^\d+(\.\d+){0,3}$/.test(withoutBrackets)) return [withoutBrackets];
  if (withoutBrackets === "localhost") return ["127.0.0.1", "::1"];
  const records = await lookup(withoutBrackets, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

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
  }
  return false;
}

function hasVersionSuffix(baseUrl: string): boolean {
  return /\/v\d+\/*$/.test(new URL(baseUrl).pathname);
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

const MULTIMODAL_MODEL =
  /(^|[-_/])(gpt-4o|gpt-5|vision|vl|pixtral|gemini|claude-3|claude-4|kimi|glm-4v|qwen-vl)([-_/.:]|$)/i;

export function modelSupportsVision(modelId: string): boolean {
  return MULTIMODAL_MODEL.test(modelId);
}
