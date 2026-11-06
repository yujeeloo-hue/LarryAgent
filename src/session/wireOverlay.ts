/**
 * Marker on the trailing role overlay. That overlay is a wire-only `user`
 * message (Deepseek hoists trailing `system` into the prefix). It must never
 * appear in the conversation pane.
 */
export const WIRE_OVERLAY_HEADER =
  "[Role overlay — ephemeral, not from the user]";

export function wrapWireOverlayBody(body: string): string {
  return `${WIRE_OVERLAY_HEADER}\n${body}`;
}

export function isWireOverlayUserContent(content: string): boolean {
  return content.startsWith(WIRE_OVERLAY_HEADER);
}

/** True when a transcript message is the ephemeral overlay (should not render). */
export function isWireOverlayTranscriptMessage(message: {
  role: string;
  parts?: Array<{ type?: unknown; text?: unknown }>;
}): boolean {
  if (message.role !== "user") return false;
  const text = (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trimStart();
  return isWireOverlayUserContent(text);
}
