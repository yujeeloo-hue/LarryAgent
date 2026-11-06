/**
 * Single source for the present_demo confirm-message format (plan D7).
 * The confirm message is a plain user message in the transcript; the marker
 * prefix is what the settled scan (tool card), the compact summary card, and
 * the compaction verbatim appendix all match on. Shared by the main process,
 * the renderer, and the relay web console — do not fork this format.
 */

export const DEMO_CONFIRM_PREFIX = "Demo confirmed [demo:";

export type DemoConfirmMessage = {
  toolCallId: string;
  paramsJson: string;
  note?: string;
};

/**
 * D7 wire format (one line each):
 * Demo confirmed [demo:<toolCallId>]:
 * ```json
 * <paramsJson>
 * ```
 * Note: <note>            (optional)
 */
export function buildDemoConfirmMessage(input: {
  toolCallId: string;
  paramsJson: string;
  note?: string;
}): string {
  const lines = [
    `${DEMO_CONFIRM_PREFIX}${input.toolCallId}]:`,
    "```json",
    input.paramsJson,
    "```",
  ];
  const note = input.note?.trim();
  if (note) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

/** Extract the toolCallId from a D7 confirm message text, or null. */
export function parseDemoConfirmToolCallId(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(DEMO_CONFIRM_PREFIX)) return null;
  const rest = trimmed.slice(DEMO_CONFIRM_PREFIX.length);
  const close = rest.indexOf("]:");
  if (close <= 0) return null;
  const id = rest.slice(0, close).trim();
  return id || null;
}

/**
 * Full D7 parse: marker + fenced json payload + optional note line.
 * Tolerant on the payload (first non-empty line when the fence is missing)
 * — the marker prefix is the only strict requirement. Returns null when the
 * text is not a demo confirm message.
 */
export function parseDemoConfirmMessage(
  text: string,
): DemoConfirmMessage | null {
  const trimmed = text.trimStart();
  const toolCallId = parseDemoConfirmToolCallId(trimmed);
  if (!toolCallId) return null;
  const markerEnd = trimmed.indexOf("]:") + 2;
  const body = trimmed.slice(markerEnd).trim();

  const fence = body.match(/^```json\r?\n([\s\S]*?)\r?\n```/);
  if (fence) {
    const paramsJson = fence[1]!.trim();
    const rest = body.slice(fence[0].length).trim();
    const note = rest.match(/^Note:\s*([\s\S]*)$/);
    return {
      toolCallId,
      paramsJson,
      ...(note && note[1]!.trim() ? { note: note[1]!.trim() } : {}),
    };
  }

  const firstLine = body.split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine) return { toolCallId, paramsJson: "" };
  const noteText = body.slice(firstLine.length).trim();
  const note = noteText.replace(/^Note:\s*/, "").trim();
  return {
    toolCallId,
    paramsJson: firstLine,
    ...(note ? { note } : {}),
  };
}
