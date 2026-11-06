/**
 * Process-wide write_file / patch / write_plan_doc argument stream state.
 *
 * ConversationController is destroyed when switching sessions, but the turn
 * keeps streaming. This module keeps accumulating tool_call_delta args so
 * remount can restore streaming cards instead of appending onto an empty buffer.
 */

import { appendToolCallArguments } from "../../../llm/appendToolCallArguments.js";
import {
  parsePartialWriteFileArgs,
  patchHeaderPathFromText,
} from "../screens/conversation/cards/parsePartialWriteArgs.js";

const LIVE_WRITE_TOOLS = new Set([
  "write_file",
  "patch",
  "write_plan_doc",
]);

function isLiveWriteTool(name: string): boolean {
  return LIVE_WRITE_TOOLS.has(name);
}

/** Name still arriving (w / write_ / write_fil) or not yet known. */
function mayBecomeLiveWriteTool(name: string): boolean {
  if (!name) return true;
  if (isLiveWriteTool(name)) return true;
  for (const candidate of LIVE_WRITE_TOOLS) {
    if (candidate.startsWith(name)) return true;
  }
  return false;
}

export type WriteStreamEntry = {
  id: string;
  messageId: string;
  /** write_file | patch | write_plan_doc */
  name: string;
  argumentsRaw: string;
  path?: string;
  /** write_plan_doc title (filename slug source). */
  title?: string;
  content?: string;
  /** patch tool V4A body (streaming preview source). */
  patchText?: string;
  oldString?: string;
  newString?: string;
  /** True once the complete `tool_call` event materialized this call. */
  called?: boolean;
};

export type WriteStreamChange = {
  sessionId: string;
  toolCallId?: string;
  /** Provider upgraded pending-N → real tool call id. */
  retarget?: { from: string; to: string };
};

type SessionBucket = {
  byId: Map<string, WriteStreamEntry>;
  lastPendingByMessage: Map<string, string>;
};

const bySession = new Map<string, SessionBucket>();
const listeners = new Set<(change: WriteStreamChange) => void>();
/**
 * Entries whose parsed fields lag `argumentsRaw`. Deltas only append; the
 * body is re-parsed on read — parsing per delta is O(n²) on large writes and
 * runs for every streaming session, focused or not.
 */
const staleEntries = new WeakSet<WriteStreamEntry>();

let bridgeUnsub: (() => void) | null = null;

function bucket(sessionId: string): SessionBucket {
  let b = bySession.get(sessionId);
  if (!b) {
    b = {
      byId: new Map(),
      lastPendingByMessage: new Map(),
    };
    bySession.set(sessionId, b);
  }
  return b;
}

function refreshParsed(entry: WriteStreamEntry): void {
  const parsed = parsePartialWriteFileArgs(entry.argumentsRaw);
  if (parsed.path !== undefined) entry.path = parsed.path;
  if (parsed.title !== undefined) entry.title = parsed.title;
  if (parsed.content !== undefined) entry.content = parsed.content;
  if (parsed.patchText !== undefined) entry.patchText = parsed.patchText;
  if (parsed.oldString !== undefined) entry.oldString = parsed.oldString;
  if (parsed.newString !== undefined) entry.newString = parsed.newString;
  if (entry.name === "patch" && entry.patchText !== undefined) {
    // Re-derive on every delta: the patch tool has no path arg, and an
    // earlier partial body must never freeze a wrong sticky path.
    const headerPath = patchHeaderPathFromText(entry.patchText);
    if (headerPath !== undefined) entry.path = headerPath;
    else delete entry.path;
  }
}

function notify(change: WriteStreamChange): void {
  for (const listener of listeners) listener(change);
}

function adoptOrCreate(
  sessionId: string,
  id: string,
  messageId: string,
  name: string,
): { entry: WriteStreamEntry; retarget?: { from: string; to: string } } {
  const b = bucket(sessionId);

  if (messageId && !id.startsWith("pending-")) {
    const pendingId = b.lastPendingByMessage.get(messageId);
    if (pendingId && pendingId !== id) {
      const existing = b.byId.get(pendingId);
      if (existing) {
        b.byId.delete(pendingId);
        b.lastPendingByMessage.delete(messageId);
        existing.id = id;
        existing.name = name;
        b.byId.set(id, existing);
        return { entry: existing, retarget: { from: pendingId, to: id } };
      }
    }
  }

  const created: WriteStreamEntry = {
    id,
    messageId,
    name,
    argumentsRaw: "",
  };
  b.byId.set(id, created);
  if (messageId && id.startsWith("pending-")) {
    b.lastPendingByMessage.set(messageId, id);
  }
  return { entry: created };
}

function applyToolCallDelta(
  sessionId: string,
  event: StreamEvent,
): WriteStreamChange | null {
  const id = typeof event.id === "string" ? event.id : "";
  if (!id) return null;
  const name = typeof event.name === "string" ? event.name.trim() : "";
  const messageId =
    typeof event.messageId === "string" ? event.messageId : "";
  const delta =
    typeof event.argumentsRawDelta === "string"
      ? event.argumentsRawDelta
      : "";

  const b = bucket(sessionId);
  let entry = b.byId.get(id);
  let retarget: { from: string; to: string } | undefined;

  if (!entry && mayBecomeLiveWriteTool(name)) {
    const adopted = adoptOrCreate(
      sessionId,
      id,
      messageId,
      isLiveWriteTool(name) ? name : "",
    );
    entry = adopted.entry;
    retarget = adopted.retarget;
  } else if (!entry) {
    return null;
  } else if (name && !mayBecomeLiveWriteTool(name)) {
    b.byId.delete(id);
    return null;
  }

  if (isLiveWriteTool(name)) {
    entry.name = name;
  }
  if (messageId) entry.messageId = messageId;
  if (delta) {
    // Must match the LLM client: GLM resends full JSON snapshots per chunk.
    entry.argumentsRaw = appendToolCallArguments(entry.argumentsRaw, delta);
    staleEntries.add(entry);
  }
  if (!isLiveWriteTool(entry.name)) return null;
  return { sessionId, toolCallId: entry.id, ...(retarget ? { retarget } : {}) };
}

function applyToolCall(
  sessionId: string,
  event: StreamEvent,
): WriteStreamChange | null {
  const name = typeof event.name === "string" ? event.name.trim() : "";
  if (!isLiveWriteTool(name)) return null;
  const id = typeof event.id === "string" ? event.id : "";
  if (!id) return null;
  const messageId =
    typeof event.messageId === "string" ? event.messageId : "";
  const argumentsRaw =
    typeof event.argumentsRaw === "string" ? event.argumentsRaw : "";

  const b = bucket(sessionId);
  let entry = b.byId.get(id);
  let retarget: { from: string; to: string } | undefined;
  if (!entry) {
    const adopted = adoptOrCreate(sessionId, id, messageId, name);
    entry = adopted.entry;
    retarget = adopted.retarget;
  }
  entry.name = name;
  entry.called = true;
  if (messageId) entry.messageId = messageId;
  if (argumentsRaw) entry.argumentsRaw = argumentsRaw;
  refreshParsed(entry);
  staleEntries.delete(entry);
  if (
    entry.content === undefined &&
    event.arguments &&
    typeof event.arguments === "object"
  ) {
    const record = event.arguments as Record<string, unknown>;
    const content = record.content;
    if (typeof content === "string") entry.content = content;
    const path = record.path;
    if (typeof path === "string") entry.path = path;
    const title = record.title;
    if (typeof title === "string") entry.title = title;
    const patchText =
      (typeof record.patch === "string" ? record.patch : undefined) ??
      (typeof record.patch_text === "string" ? record.patch_text : undefined);
    if (typeof patchText === "string") entry.patchText = patchText;
    const oldString = record.old_string;
    if (typeof oldString === "string") entry.oldString = oldString;
    const newString = record.new_string;
    if (typeof newString === "string") entry.newString = newString;
  }
  return { sessionId, toolCallId: entry.id, ...(retarget ? { retarget } : {}) };
}

function clearTool(
  sessionId: string,
  toolCallId: string,
  messageId?: string,
): WriteStreamChange | null {
  const b = bySession.get(sessionId);
  if (!b) return null;
  const had = b.byId.delete(toolCallId);
  if (messageId) b.lastPendingByMessage.delete(messageId);
  if (b.byId.size === 0 && b.lastPendingByMessage.size === 0) {
    bySession.delete(sessionId);
  }
  return had ? { sessionId, toolCallId } : null;
}

/** Drop all in-flight write streams for a session (turn end / cancel). */
export function clearSessionWriteStreams(sessionId: string): void {
  if (!bySession.delete(sessionId)) return;
  notify({ sessionId });
}

/**
 * Interrupt sealed the round mid-args-stream: entries that never saw a
 * complete `tool_call` (half-emitted calls are dropped main-side, whether
 * their streamed id was pending-N or already real) must not survive a remount
 * or keep a painted preview card "streaming" forever. Args only stream inside
 * the live round, so every unresolved entry at interrupt time belongs to the
 * interrupted round. Materialized calls are untouched — sealed/running writes
 * still reconcile through their own tool_finished.
 * Returns the dropped ids so callers can remove painted preview cards.
 */
export function dropUnresolvedWriteStreams(sessionId: string): string[] {
  const b = bySession.get(sessionId);
  if (!b) return [];
  const dropped: string[] = [];
  for (const [id, entry] of b.byId) {
    if (entry.called) continue;
    b.byId.delete(id);
    dropped.push(id);
  }
  b.lastPendingByMessage.clear();
  if (b.byId.size === 0) bySession.delete(sessionId);
  return dropped;
}

export function listWriteStreams(sessionId: string): WriteStreamEntry[] {
  const b = bySession.get(sessionId);
  if (!b) return [];
  for (const entry of b.byId.values()) {
    if (!staleEntries.has(entry)) continue;
    refreshParsed(entry);
    staleEntries.delete(entry);
  }
  return [...b.byId.values()];
}

/**
 * Scan entries by identity / lifecycle fields without parsing argument
 * bodies — safe to call on every stream change.
 */
export function someWriteStream(
  sessionId: string,
  predicate: (
    entry: Pick<WriteStreamEntry, "id" | "messageId" | "name" | "called">,
  ) => boolean,
): boolean {
  const b = bySession.get(sessionId);
  if (!b) return false;
  for (const entry of b.byId.values()) {
    if (predicate(entry)) return true;
  }
  return false;
}

export function subscribeWriteStreams(
  listener: (change: WriteStreamChange) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Keep accumulating write args for every session, even when no conversation
 * screen is mounted.
 */
export function ensureWriteStreamBackgroundListener(
  bridge: NonNullable<Window["jellybot"]>,
): void {
  if (bridgeUnsub) return;
  bridgeUnsub = bridge.onAgentStream((payload) => {
    const { sessionId, event } = payload;
    let change: WriteStreamChange | null = null;
    switch (event.type) {
      case "tool_call_delta":
        change = applyToolCallDelta(sessionId, event);
        break;
      case "tool_call":
        change = applyToolCall(sessionId, event);
        break;
      case "tool_finished":
        if (
          typeof event.id === "string" &&
          typeof event.messageId === "string"
        ) {
          change = clearTool(sessionId, event.id, event.messageId);
        }
        break;
      case "done":
        clearSessionWriteStreams(sessionId);
        return;
      case "status": {
        const status = event.status;
        if (
          status === "idle" ||
          status === "completed" ||
          status === "error" ||
          status === "cancelled"
        ) {
          clearSessionWriteStreams(sessionId);
          return;
        }
        break;
      }
      case "error":
        clearSessionWriteStreams(sessionId);
        return;
      default:
        break;
    }
    if (change) notify(change);
  });
}
