import type { JsonObject } from "../session/types.js";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function shouldEnableGlmToolStream(
  baseUrl: string,
  modelId?: string,
): boolean {
  const host = hostOf(baseUrl).toLowerCase();
  const model = (modelId ?? "").toLowerCase();
  if (
    host.includes("bigmodel") ||
    host.includes("z.ai") ||
    host.includes("zhipu") ||
    host.includes("glm") ||
    host.includes("lkeap")
  ) {
    return true;
  }
  return /(?:^|[._-])glm/.test(model);
}

export function glmToolStreamBody(
  baseUrl: string,
  modelId?: string,
): JsonObject | undefined {
  if (!shouldEnableGlmToolStream(baseUrl, modelId)) return undefined;
  return { tool_stream: true };
}
