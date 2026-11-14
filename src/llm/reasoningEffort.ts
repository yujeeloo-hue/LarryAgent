import type { JsonObject } from "../session/types.js";
import { reasoningDisableExtraBody } from "./reasoningDisable.js";

/**
 * Composer reasoning-effort dial (five levels).
 *
 * Surveyed against provider docs (2026-09):
 * - low / medium / high: accepted by every provider (the common scale).
 * - max: native top tier on DeepSeek / Kimi / GLM (all three default to it),
 *   also supported by newer OpenAI models and Claude Opus via gateways.
 * - off: "disable thinking" — no provider accepts an effort value for this;
 *   it maps onto the provider-specific disable switches (reasoningDisable).
 * - xhigh deliberately NOT a level: only newer OpenAI models + Claude expose
 *   it; DeepSeek clamps it to high, Kimi / GLM reject it outright.
 */
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

/** Ordered dial positions (OFF → MAX). */
export const REASONING_EFFORT_LEVELS: readonly ReasoningEffort[] = [
  "off",
  "low",
  "medium",
  "high",
  "max",
];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Normalize any stored/legacy value into a dial level.
 * - Legacy booleans: `true` (Reasoning Max on) → "max", `false` → "low".
 * - null / undefined / invalid → `fallback` ("low" — the dial default that
 *   keeps chat turns explicit: omitting the field would fall back to the
 *   provider default, e.g. Kimi K3 defaults to max).
 */
export function normalizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = "low",
): ReasoningEffort {
  if (isReasoningEffort(value)) return value;
  if (value === true) return "max";
  if (value === false) return "low";
  return fallback;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Providers without a native `medium` (Kimi / Moonshot hosts, GLM / Z.ai /
 * bigmodel / lkeap hosts): clamp client-side to the nearest level "high" —
 * the same convention DeepSeek itself documents for its compatibility
 * mapping (medium → high). DeepSeek keeps accepting "medium" natively, so
 * it is passed through unchanged.
 */
function clampsMediumToHigh(host: string): boolean {
  const lowered = host.toLowerCase();
  return (
    lowered.includes("moonshot") ||
    lowered.includes("z.ai") ||
    lowered.includes("glm") ||
    lowered.includes("bigmodel") ||
    lowered.includes("lkeap")
  );
}

/**
 * Chat-completions extra body for a dial level on a given host.
 *
 * - "off" reuses the Ask-mode disable layer (`reasoningDisableExtraBody`):
 *   TokenLink `reasoning_effort: "no_think"`, DeepSeek
 *   `thinking: {type:"disabled"}`, GLM `enableReasoning: false`, plus a
 *   `reasoning_effort: "low"` compat double-write elsewhere.
 * - Other levels send `reasoning_effort` directly; Kimi/GLM hosts never
 *   see "medium" (clamped to "high").
 */
export function reasoningEffortExtraBody(
  baseUrl: string,
  level: ReasoningEffort,
): JsonObject {
  if (level === "off") {
    return reasoningDisableExtraBody(baseUrl);
  }
  const host = hostOf(baseUrl);
  if (level === "medium" && clampsMediumToHigh(host)) {
    return { reasoning_effort: "high" };
  }
  return { reasoning_effort: level };
}
