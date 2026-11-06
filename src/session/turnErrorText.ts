/**
 * Turn-error row detection, shared by renderer (Retry pill) and main
 * (consumeTurnErrorMessage). Lives outside renderer/ so both sides agree:
 * a row the renderer offers Retry on MUST be removable by main, otherwise
 * the error survives in the store and its Retry pill resurfaces on every
 * conversation re-entry.
 */

/** Push-site prefixes from before TextPart.error existed (stable). */
export const TURN_ERROR_LEGACY_PREFIXES = [
  "Queued message could not start a turn:",
  "Turn handoff failed to start:",
] as const;

function asTextPart(
  part: unknown,
): { text: string; error?: unknown } | null {
  if (typeof part !== "object" || part === null) return null;
  const p = part as { type?: unknown; text?: unknown; error?: unknown };
  if (p.type !== "text" || typeof p.text !== "string") return null;
  return { text: p.text, error: p.error };
}

/** True when this text part reports a turn failure (marker or legacy prefix). */
export function isTurnErrorTextPart(part: unknown): boolean {
  const textPart = asTextPart(part);
  if (!textPart) return false;
  if (textPart.error === true) return true;
  return TURN_ERROR_LEGACY_PREFIXES.some((prefix) =>
    textPart.text.startsWith(prefix),
  );
}

/** True when the message is a system text row that should render as an error card. */
export function isTurnErrorMessage(message: {
  role: string;
  parts: Array<Record<string, unknown>>;
}): boolean {
  if (message.role !== "system") return false;
  return message.parts.some((part) => isTurnErrorTextPart(part));
}
