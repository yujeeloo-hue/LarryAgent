import type { JsonObject } from "../session/types.js";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * There is no industry-wide standard for disabling model reasoning. Different
 * providers expose different switches, and OpenAI-compatible gateways ignore
 * unknown body fields (so double-writing is harmless):
 *
 * - DeepSeek (api.deepseek.com): `thinking: {type: "disabled"}`
 * - GLM / Z.ai / LKEAP (bigmodel.cn, z.ai, lkeap endpoints): `enableReasoning: false`
 * - OpenAI-style (OpenAI / Kimi / xAI): `reasoning_effort: "low"` (only
 *   down-ranks, cannot fully disable — shipped as a best-effort fallback)
 *
 * Strategy: always write `reasoning_effort: "low"`; add the provider-specific
 * switch for known hosts; for unknown gateways double-write both conventions
 * (ignored when unsupported, so safe).
 *
 * Consumers: Ask-mode chat (via llmBinding) and context-compaction summaries
 * (Cold / Warm / iteration-protect), which should not burn CoT tokens.
 */
export function reasoningDisableExtraBody(baseUrl: string): JsonObject {
  const host = hostOf(baseUrl).toLowerCase();
  const fields: JsonObject = { reasoning_effort: "low" };
  if (host.includes("deepseek")) {
    fields.thinking = { type: "disabled" };
  } else if (
    host.includes("z.ai") ||
    host.includes("glm") ||
    host.includes("lkeap") ||
    host.includes("bigmodel")
  ) {
    fields.enableReasoning = false;
  } else {
    fields.thinking = { type: "disabled" };
    fields.enableReasoning = false;
  }
  return fields;
}

/**
 * Merge provider reasoning-off fields with call-site extras.
 * Call-site keys win on collision. Extras are for non-sampling fields only
 * (e.g. max_tokens) — sampling params (temperature / top_p) are never set:
 * Kimi K-series forbids them; provider defaults are used everywhere.
 */
export function noReasoningExtraBody(
  baseUrl: string,
  extra?: JsonObject,
): JsonObject {
  return {
    ...reasoningDisableExtraBody(baseUrl),
    ...(extra ?? {}),
  };
}
