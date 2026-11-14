/**
 * Resolve LLM-assigned subagent nicknames for conversation tool cards.
 * Only explicit `name` / legacy `title` args count — not prompt-derived fallbacks.
 */

const DISPATCH_ID_RE = /\(id=([A-Za-z0-9_]+)\)/;

export function nicknameFromSubagentArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const raw = args as Record<string, unknown>;
  if (typeof raw.name === "string" && raw.name.trim()) {
    return raw.name.trim();
  }
  if (typeof raw.title === "string" && raw.title.trim()) {
    return raw.title.trim();
  }
  return undefined;
}

function idsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const raw = (args as Record<string, unknown>).ids;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out;
}

function textFromResultContent(
  content: Array<Record<string, unknown>> | undefined,
): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function parseDispatchIdFromResultText(text: string): string | undefined {
  const match = text.match(DISPATCH_ID_RE);
  const id = match?.[1]?.trim();
  return id || undefined;
}

type MessageLike = {
  parts: Array<Record<string, unknown>>;
};

/**
 * Map subagent run id → explicit nickname from dispatch tool_call args + result.
 */
export function buildSubagentNamesById(
  messages: MessageLike[],
): Map<string, string> {
  const namesById = new Map<string, string>();
  const pendingByToolCallId = new Map<string, string>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === "tool_call" &&
        part.name === "dispatch_subagent" &&
        typeof part.id === "string"
      ) {
        const nickname = nicknameFromSubagentArgs(part.arguments);
        if (nickname) pendingByToolCallId.set(part.id, nickname);
      }

      if (part.type === "tool_result" && typeof part.toolCallId === "string") {
        const nickname = pendingByToolCallId.get(part.toolCallId);
        if (!nickname) continue;
        const text = textFromResultContent(
          Array.isArray(part.content)
            ? (part.content as Array<Record<string, unknown>>)
            : undefined,
        );
        const runId = parseDispatchIdFromResultText(text);
        if (runId) namesById.set(runId, nickname);
      }
    }
  }

  return namesById;
}

/** Card title for subagent tools; includes nicknames when known. */
export function subagentCardLabel(
  toolName: string,
  args: unknown,
  namesById?: Map<string, string>,
): string {
  if (toolName === "dispatch_subagent") {
    const nickname = nicknameFromSubagentArgs(args);
    const batchId =
      args && typeof args === "object" && !Array.isArray(args)
        ? typeof (args as Record<string, unknown>).batch_id === "string"
          ? String((args as Record<string, unknown>).batch_id).trim()
          : ""
        : "";
    if (nickname && batchId) return `Subagent → ${nickname}`;
    if (nickname) return `Subagent → ${nickname}`;
    if (batchId) return `Subagent → ${batchId}`;
    return "Subagent";
  }

  if (toolName === "subagent_batch_result") {
    const batchId =
      args && typeof args === "object" && !Array.isArray(args)
        ? typeof (args as Record<string, unknown>).batch_id === "string"
          ? String((args as Record<string, unknown>).batch_id).trim()
          : ""
        : "";
    return batchId ? `Subagent batch → ${batchId}` : "Subagent batch";
  }

  const resolved = idsFromArgs(args)
    .map((id) => namesById?.get(id))
    .filter((n): n is string => Boolean(n));
  // De-dupe while preserving order.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const n of resolved) {
    if (seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  const joined = names.join(", ");

  if (toolName === "await_subagent") {
    return joined
      ? `Subagent Task Summary → ${joined}`
      : "Subagent Task Summary";
  }
  if (toolName === "stop_subagent") {
    return joined ? `Stop → ${joined}` : "Stop Subagent";
  }
  if (toolName === "get_subagent_status") {
    return joined ? `Status → ${joined}` : "Subagent Status";
  }
  if (toolName === "list_subagents") {
    return "List Subagents";
  }
  return toolName;
}
