import type { JsonObject } from "../session/types.js";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Zhipu GLM buffers Function Call arguments unless `tool_stream: true`.
 * `stream: true` alone still streams text / reasoning only.
 * Docs: https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool
 * Supported: GLM-5.x / GLM-4.7 / GLM-4.6 (ignored by other OpenAI gateways).
 */
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

/** Request-body fields to merge when the call offers tools. */
export function glmToolStreamBody(
  baseUrl: string,
  modelId?: string,
): JsonObject | undefined {
  if (!shouldEnableGlmToolStream(baseUrl, modelId)) return undefined;
  return { tool_stream: true };
}
