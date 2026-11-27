import type { JsonObject } from "../session/types.js";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function reasoningDisableExtraBody(baseUrl: string): JsonObject {
  const host = hostOf(baseUrl).toLowerCase();
  if (host.includes("tokenlink")) {
    return { reasoning_effort: "no_think" };
  }
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

export function noReasoningExtraBody(
  baseUrl: string,
  extra?: JsonObject,
): JsonObject {
  return {
    ...reasoningDisableExtraBody(baseUrl),
    ...(extra ?? {}),
  };
}
