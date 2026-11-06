import type { StreamUsageEvent } from "./streamEvents.js";

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readDetailsCached(details: unknown): {
  cachedTokens?: number;
  cacheWriteTokens?: number;
} {
  if (typeof details !== "object" || details === null) return {};
  const d = details as Record<string, unknown>;
  const cachedTokens =
    asFiniteNumber(d.cached_tokens) ??
    asFiniteNumber(d.cache_read_input_tokens) ??
    asFiniteNumber(d.cachedTokens);
  const cacheWriteTokens =
    asFiniteNumber(d.cache_write_tokens) ??
    asFiniteNumber(d.cache_creation_input_tokens) ??
    asFiniteNumber(d.cacheWriteTokens);
  return {
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

/**
 * Normalize OpenAI-compatible (and common gateway) usage payloads into a
 * StreamUsageEvent. Supports Chat Completions + Anthropic-style aliases.
 */
export function parseOpenAiUsage(usage: unknown): StreamUsageEvent | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;

  const promptTokens =
    asFiniteNumber(u.prompt_tokens) ?? asFiniteNumber(u.input_tokens);
  const completionTokens =
    asFiniteNumber(u.completion_tokens) ?? asFiniteNumber(u.output_tokens);
  const totalTokens = asFiniteNumber(u.total_tokens);

  const fromDetails = {
    ...readDetailsCached(u.prompt_tokens_details),
    ...readDetailsCached(u.input_tokens_details),
  };
  const cachedTokens =
    fromDetails.cachedTokens ??
    asFiniteNumber(u.cache_read_input_tokens) ??
    asFiniteNumber(u.cached_tokens);
  const cacheWriteTokens =
    fromDetails.cacheWriteTokens ??
    asFiniteNumber(u.cache_creation_input_tokens) ??
    asFiniteNumber(u.cache_write_tokens);

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cachedTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return null;
  }

  const event: StreamUsageEvent = { type: "usage" };
  if (promptTokens !== undefined) event.promptTokens = promptTokens;
  if (completionTokens !== undefined) event.completionTokens = completionTokens;
  if (totalTokens !== undefined) event.totalTokens = totalTokens;
  if (cachedTokens !== undefined) event.cachedTokens = cachedTokens;
  if (cacheWriteTokens !== undefined) event.cacheWriteTokens = cacheWriteTokens;
  return event;
}
