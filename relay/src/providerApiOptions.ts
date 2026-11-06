/** Mirror of desktop provider API preferences; the Relay builds separately. */
export type ProviderApiOptions = {
  apiProtocol?: "auto" | "chat_completions" | "responses";
  responsesTools?: Array<Record<string, unknown>>;
  responsesStateful?: boolean;
};

/** Mirror of the desktop URL normalizer; query/hash content is opaque. */
export function normalizeProviderBaseUrl(baseUrl: string, rawEndpoint = false): string {
  const value = baseUrl.trim();
  if (rawEndpoint) return value;
  const at = value.search(/[?#]/);
  const path = at < 0 ? value : value.slice(0, at);
  const suffix = at < 0 ? "" : value.slice(at);
  return path.replace(/\/+$/, "") + suffix;
}

export function normalizeProviderApiOptions(value: unknown): ProviderApiOptions {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const out: ProviderApiOptions = {};
  if (input.apiProtocol === "auto" || input.apiProtocol === "chat_completions" || input.apiProtocol === "responses") out.apiProtocol = input.apiProtocol;
  if (typeof input.responsesStateful === "boolean") out.responsesStateful = input.responsesStateful;
  if (Array.isArray(input.responsesTools)) {
    out.responsesTools = input.responsesTools.filter((tool) => tool && typeof tool === "object" && !Array.isArray(tool))
      .map((tool) => JSON.parse(JSON.stringify(tool)) as Record<string, unknown>);
  }
  return out;
}

export function parseProviderApiOptions(json: string | undefined): ProviderApiOptions {
  try { return normalizeProviderApiOptions(JSON.parse(json || "{}")); }
  catch { return {}; }
}
