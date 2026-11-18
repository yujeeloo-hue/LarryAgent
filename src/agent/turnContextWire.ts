import type { TurnContextPart } from "../session/types.js";

export function formatTurnContextForWire(part: TurnContextPart): string {
  return [
    `<turn_context source="${part.source}">`,
    "Captured automatically when this message was sent; not written by the user.",
    part.text.trim(),
    "</turn_context>",
  ].join("\n");
}
