/**
 * Accumulate streamed tool-call argument fragments.
 *
 * OpenAI-style gateways send incremental JSON pieces of one object
 * (`{"path":"` then `/x"}`). Some (e.g. GLM with `tool_stream`) resend a
 * growing root object on each chunk — appending those yields `{}{}` or
 * unbounded `{"a":…{"a":…` growth when early frames are still unclosed.
 *
 * Snapshots are detected without guessing from the leading `{` alone:
 * a growing snapshot repeats the whole buffer as its own prefix, and a fresh
 * snapshot can only follow a buffer that already parses as a complete object.
 * Incremental fragments that open a nested object (`{"arguments":` then
 * `{"scope":"active"}`, or a `{` inside a `write_file` content string) fail
 * both checks and keep concatenating.
 */
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
