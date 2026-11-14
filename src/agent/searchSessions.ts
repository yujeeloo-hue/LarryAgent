import type { Message, Session } from "../session/types.js";
import type { Workspace } from "../workspace/types.js";

export type SessionSearchHit = {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  updatedAt: number;
  matchKind: "title" | "message";
  preview: string;
};

const PREVIEW_RADIUS = 72;
const MAX_HITS = 200;

function collectSearchableTexts(message: Message): string[] {
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim()) {
      texts.push(part.text);
      continue;
    }
    if (part.type === "tool_result") {
      for (const child of part.content) {
        if (child.type === "text" && child.text.trim()) {
          texts.push(child.text);
        }
      }
      continue;
    }
    if (part.type === "tool_call") {
      if (part.name.trim()) texts.push(part.name);
      if (part.argumentsRaw.trim()) texts.push(part.argumentsRaw);
      continue;
    }
    if (part.type === "context_compaction" && part.summary.trim()) {
      texts.push(part.summary);
    }
  }
  return texts;
}

function makeSnippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx < 0) {
    return normalized.length > PREVIEW_RADIUS * 2
      ? `${normalized.slice(0, PREVIEW_RADIUS * 2)}…`
      : normalized;
  }
  const start = Math.max(0, idx - PREVIEW_RADIUS);
  const end = Math.min(normalized.length, idx + query.length + PREVIEW_RADIUS);
  let snippet = normalized.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < normalized.length) snippet = `${snippet}…`;
  return snippet;
}

/**
 * Search agent session titles and message content. One hit per session
 * (title match preferred over the first message match).
 */
export function searchSessionsInMemory(
  sessions: Iterable<Session>,
  workspaces: Workspace[],
  rawQuery: string,
): SessionSearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const workspaceById = new Map(workspaces.map((w) => [w.id, w]));
  const hits: SessionSearchHit[] = [];

  for (const session of sessions) {
    if (session.type !== "agent") continue;

    const workspace = workspaceById.get(session.workspaceId);
    const workspaceName =
      workspace?.name.trim() ||
      (session.workspaceId.trim() ? session.workspaceId : "Unknown workspace");
    const workspacePath = workspace?.path || session.workspacePath || "";

    const title = session.title.trim() || "Untitled";
    if (title.toLowerCase().includes(query)) {
      hits.push({
        sessionId: session.id,
        sessionTitle: title,
        workspaceId: session.workspaceId,
        workspaceName,
        workspacePath,
        updatedAt: session.updatedAt,
        matchKind: "title",
        preview: title,
      });
      continue;
    }

    let messageHit: SessionSearchHit | null = null;
    for (const message of session.messages) {
      if (message.role === "system") continue;
      for (const text of collectSearchableTexts(message)) {
        if (!text.toLowerCase().includes(query)) continue;
        messageHit = {
          sessionId: session.id,
          sessionTitle: title,
          workspaceId: session.workspaceId,
          workspaceName,
          workspacePath,
          updatedAt: session.updatedAt,
          matchKind: "message",
          preview: makeSnippet(text, query),
        };
        break;
      }
      if (messageHit) break;
    }
    if (messageHit) hits.push(messageHit);
    if (hits.length >= MAX_HITS) break;
  }

  hits.sort((a, b) => b.updatedAt - a.updatedAt);
  return hits.slice(0, MAX_HITS);
}
