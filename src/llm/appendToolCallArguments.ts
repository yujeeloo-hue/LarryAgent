export function appendToolCallArguments(
  current: string,
  delta: string,
): string {
  if (!delta) return current;
  if (!current) return delta;
  const currentTrimmed = current.trim();
  const deltaTrimmed = delta.trim();
  if (deltaTrimmed.startsWith(currentTrimmed)) return delta;
  if (isCompleteJsonObject(currentTrimmed) && deltaTrimmed.startsWith("{")) {
    return delta;
  }
  return current + delta;
}

export function toolCallArgumentsDeltaToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return "";
    }
  }
  return "";
}

function isCompleteJsonObject(raw: string): boolean {
  if (!raw.startsWith("{") || !raw.endsWith("}")) return false;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
