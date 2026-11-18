import type { JsonObject } from "../session/types.js";
import { reasoningDisableExtraBody } from "./reasoningDisable.js";

export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

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
