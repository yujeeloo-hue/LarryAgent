import type { MessagePart } from "../types.js";

export function isContextClearPart(part: MessagePart): boolean {
  return part.type === "context_clear";
}

export function isContextNewTaskPart(part: MessagePart): boolean {
  return part.type === "context_new_task";
}
