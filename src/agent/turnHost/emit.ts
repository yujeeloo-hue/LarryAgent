import type { StreamEvent } from "../../llm/streamEvents.js";

export function emit(
  onEvent: ((event: StreamEvent) => void) | undefined,
  event: StreamEvent,
): void {
  onEvent?.(event);
}
