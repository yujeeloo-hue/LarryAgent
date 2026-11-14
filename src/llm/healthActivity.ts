/**
 * Endpoint-level LLM activity registry (main process, in-memory).
 *
 * Every successful real chat response proves the endpoint is alive exactly as
 * strongly as a health probe would, so the composer's 60s poll can skip the
 * network entirely while conversation traffic is flowing ("interaction is the
 * probe"). Keys isolate gateways AND credentials: same base URL with two
 * different API keys must not mark each other healthy.
 */

/** FNV-1a 32-bit — cheap non-crypto credential fingerprint for map keys. */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stable identity for one provider credential at one gateway:
 * `<resolved chat endpoint>|<model>|<apiKey digest>`.
 */
export function llmActivityKey(params: {
  endpointUrl: string;
  apiKey: string;
  model?: string;
}): string {
  return `${params.endpointUrl}|${params.model ?? ""}|${fnv1aHex(params.apiKey)}`;
}

const lastActivityAt = new Map<string, number>();

export function recordLlmEndpointActivity(
  key: string,
  now: number = Date.now(),
): void {
  lastActivityAt.set(key, now);
}

/** Milliseconds since the last recorded success; null when never active. */
export function msSinceLlmEndpointActivity(
  key: string,
  now: number = Date.now(),
): number | null {
  const at = lastActivityAt.get(key);
  if (at === undefined) return null;
  return Math.max(0, now - at);
}

export function isLlmEndpointRecentlyActive(
  key: string,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const since = msSinceLlmEndpointActivity(key, now);
  return since !== null && since < windowMs;
}

/** Test isolation only. */
export function resetLlmHealthActivityForTests(): void {
  lastActivityAt.clear();
}
