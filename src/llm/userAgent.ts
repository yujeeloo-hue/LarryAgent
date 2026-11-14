/**
 * Explicit User-Agent for every outbound LLM / provider HTTP call.
 *
 * Node's global fetch defaults to `User-Agent: node`, which some gateways
 * reject. GLM's coding endpoint (`open.bigmodel.cn/api/coding/paas/v4`) answers
 * `node` with HTTP 429 code 1305 ("该模型当前访问量过大") — a rate-limit message
 * for what is actually a client-identity block. Any other value is accepted.
 *
 * Prefer configuring from main with `app.getName()` + `app.getVersion()` so the
 * UA tracks the packaged product name.
 */

const FALLBACK_LLM_USER_AGENT = "App/0.0.0";

let userAgent = FALLBACK_LLM_USER_AGENT;

/** Sanitize an app name into a single HTTP token (no spaces / controls). */
export function sanitizeLlmUserAgentName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._+-]/g, "");
  return cleaned || "App";
}

/** Build `{AppName}/{version}` for LLM requests. */
export function buildLlmUserAgent(appName: string, version: string): string {
  const name = sanitizeLlmUserAgentName(appName);
  const ver = version.trim() || "0.0.0";
  return `${name}/${ver}`;
}

/** Set the process-wide LLM User-Agent (call once from main with the app identity). */
export function configureLlmUserAgent(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  userAgent = trimmed;
}

/** Merge the User-Agent into request headers unless the caller set one. */
export function withLlmUserAgent(
  headers: Record<string, string>,
): Record<string, string> {
  const hasOwn = Object.keys(headers).some(
    (k) => k.toLowerCase() === "user-agent",
  );
  if (hasOwn) return headers;
  return { ...headers, "User-Agent": userAgent };
}
