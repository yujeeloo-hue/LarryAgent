
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

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

export function resetLlmHealthActivityForTests(): void {
  lastActivityAt.clear();
}
