import type { MessagePart } from "../types.js";

/** /clear marker part check shared by DB window boundary scans. */
export function isContextClearPart(part: MessagePart): boolean {
  return part.type === "context_clear";
}
