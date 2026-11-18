
const FALLBACK_LLM_USER_AGENT = "App/0.0.0";

let userAgent = FALLBACK_LLM_USER_AGENT;

export function sanitizeLlmUserAgentName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._+-]/g, "");
  return cleaned || "App";
}

export function buildLlmUserAgent(appName: string, version: string): string {
  const name = sanitizeLlmUserAgentName(appName);
  const ver = version.trim() || "0.0.0";
  return `${name}/${ver}`;
}

export function configureLlmUserAgent(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  userAgent = trimmed;
}

export function withLlmUserAgent(
  headers: Record<string, string>,
): Record<string, string> {
  const hasOwn = Object.keys(headers).some(
    (k) => k.toLowerCase() === "user-agent",
  );
  if (hasOwn) return headers;
  return { ...headers, "User-Agent": userAgent };
}
