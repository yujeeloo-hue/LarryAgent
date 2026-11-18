import type { JsonObject, JsonValue } from "../session/types.js";

export type LlmApiProtocol = "auto" | "chat_completions" | "responses";
export type ResolvedLlmApiProtocol = Exclude<LlmApiProtocol, "auto">;
export type LlmApiEndpointConfig = {
  baseUrl: string;
  rawEndpoint?: boolean;
  apiProtocol?: LlmApiProtocol | undefined;
};

const ENDPOINT_SUFFIX = /\/(?:chat\/completions|responses)\/*$/i;

function splitUrl(value: string): { path: string; suffix: string } {
  const start = value.search(/[?#]/);
  return start < 0 ? { path: value, suffix: "" }
    : { path: value.slice(0, start), suffix: value.slice(start) };
}

export function normalizeLlmBaseUrl(baseUrl: string, rawEndpoint = false): string {
  if (rawEndpoint) return baseUrl.trim();
  const { path, suffix } = splitUrl(baseUrl.trim());
  return path.replace(/\/+$/, "") + suffix;
}

function isKimiCodingProfile(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl.trim());
    return url.hostname.toLowerCase() === "api.kimi.com" &&
      /^\/coding\/v1(?:\/(?:responses|chat\/completions))?\/*$/.test(url.pathname);
  } catch { return false; }
}

export function resolveResponsesStateful(config: { baseUrl: string; responsesStateful?: boolean | undefined }): boolean {
  if (typeof config.responsesStateful === "boolean") return config.responsesStateful;
  return false;
}

export function resolveLlmApiProtocol(config: LlmApiEndpointConfig): ResolvedLlmApiProtocol {
  if (config.apiProtocol === "responses" || config.apiProtocol === "chat_completions") {
    return config.apiProtocol;
  }
  const { path } = splitUrl(config.baseUrl.trim());
  if (/\/responses\/*$/i.test(path)) return "responses";
  if (/\/chat\/completions\/*$/i.test(path)) return "chat_completions";
  if (isKimiCodingProfile(config.baseUrl)) return "responses";
  try {
    const url = new URL(config.baseUrl);
    if (url.hostname.toLowerCase() === "api.openai.com" && /^\/v1\/*$/.test(url.pathname)) {
      return "responses";
    }
    if (url.hostname.toLowerCase() === "open.bigmodel.cn" && /^\/api\/v1\/*$/.test(url.pathname)) {
      return "responses";
    }
  } catch {  }
  return "chat_completions";
}

export function stripModelEndpoint(baseUrl: string): string {
  const { path, suffix } = splitUrl(baseUrl.trim());
  return path.replace(ENDPOINT_SUFFIX, "").replace(/\/+$/, "") + suffix;
}

export function modelEndpoint(
  config: LlmApiEndpointConfig,
  protocol: ResolvedLlmApiProtocol = resolveLlmApiProtocol(config),
): string {
  if (config.rawEndpoint === true) return config.baseUrl;
  const { path, suffix } = splitUrl(stripModelEndpoint(config.baseUrl));
  return `${path}/${protocol === "responses" ? "responses" : "chat/completions"}${suffix}`;
}

export function providerApiEndpoint(baseUrl: string, path: string): string {
  const split = splitUrl(stripModelEndpoint(baseUrl));
  return `${split.path}/${path.replace(/^\/+/, "")}${split.suffix}`;
}

export type LlmProviderApiOptions = {
  apiProtocol?: LlmApiProtocol;
  responsesTools?: JsonObject[];
  responsesStateful?: boolean;
};

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null &&
    Object.values(value).every(isJsonValue);
}

export function normalizeLlmProviderOptions(input: unknown): LlmProviderApiOptions {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: LlmProviderApiOptions = {};
  if (raw.apiProtocol === "auto" || raw.apiProtocol === "chat_completions" || raw.apiProtocol === "responses") {
    out.apiProtocol = raw.apiProtocol;
  }
  if (typeof raw.responsesStateful === "boolean") out.responsesStateful = raw.responsesStateful;
  if (Array.isArray(raw.responsesTools)) {
    out.responsesTools = raw.responsesTools.filter((tool): tool is JsonObject =>
      typeof tool === "object" && tool !== null && !Array.isArray(tool) && isJsonValue(tool)
    ).map((tool) => JSON.parse(JSON.stringify(tool)) as JsonObject);
  }
  return out;
}
