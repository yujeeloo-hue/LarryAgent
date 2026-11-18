
export const TURN_ERROR_LEGACY_PREFIXES = [
  "Queued message could not start a turn:",
] as const;

function asTextPart(
  part: unknown,
): { text: string; error?: unknown } | null {
  if (typeof part !== "object" || part === null) return null;
  const p = part as { type?: unknown; text?: unknown; error?: unknown };
  if (p.type !== "text" || typeof p.text !== "string") return null;
  return { text: p.text, error: p.error };
}

export function isTurnErrorTextPart(part: unknown): boolean {
  const textPart = asTextPart(part);
  if (!textPart) return false;
  if (textPart.error === true) return true;
  return TURN_ERROR_LEGACY_PREFIXES.some((prefix) =>
    textPart.text.startsWith(prefix),
  );
}

export function isTurnErrorMessage(message: {
  role: string;
  parts: Array<Record<string, unknown>>;
}): boolean {
  if (message.role !== "system") return false;
  return message.parts.some((part) => isTurnErrorTextPart(part));
}
