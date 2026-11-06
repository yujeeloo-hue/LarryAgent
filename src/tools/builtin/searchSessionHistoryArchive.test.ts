import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchSessionHistoryHandler } from "./searchSessionHistory.js";
import type { JsonObject, Message, Session } from "../../session/types.js";
import type { SessionHistoryRecord } from "../../session/db/sessionHistoryRepository.js";
import type { ToolExecuteContext } from "../types.js";

function msg(id: string, text: string, createdAt: number): Message {
  return { id, role: "user", parts: [{ type: "text", text }], createdAt };
}

const liveSession: Session = {
  id: "live-1",
  type: "agent",
  title: "Live relay work",
  createdAt: 9_000,
  updatedAt: 10_000,
  status: "idle",
  progressText: "",
  messages: [msg("lm1", "live relay deploy question", 9_500)],
  model: "m",
  providerId: "p",
  workspaceId: "ws-jb",
  workspacePath: "/jb",
  pinned: false,
  archived: false,
  archivedAt: null,
  contextUsage: { usedTokens: 0 },
  plan: null,
};

const now = 10_000;

function record(partial: {
  id: string;
  sessionId: string;
  summary: string;
  workspaceId: string;
  workspaceName: string;
  last: number;
  status?: "done" | "pending";
  summarySource?: "llm" | "empty" | "discarded";
}): SessionHistoryRecord {
  return {
    id: partial.id,
    sessionId: partial.sessionId,
    title: `T-${partial.sessionId}`,
    workspaceId: partial.workspaceId,
    workspaceName: partial.workspaceName,
    workspacePath: "/tmp",
    providerId: "p",
    model: "old",
    deviceId: "dev-local",
    deviceName: "Mac",
    deviceOs: "darwin arm64 24.0.0",
    appVersion: "1.0.0",
    sessionCreatedAt: partial.last - 5_000,
    sessionUpdatedAt: partial.last,
    firstMessageAt: partial.last - 4_000,
    lastMessageAt: partial.last,
    deletedAt: partial.last + 100,
    status: partial.status ?? "done",
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    summary: partial.summary,
    summarySource: partial.summarySource ?? "llm",
    inputTruncated: false,
    summaryModel: "old",
    summarizedAt: partial.last + 100,
  };
}

const historyRecords: SessionHistoryRecord[] = [
  record({
    id: "h1",
    sessionId: "dead-1",
    summary: "Archived: fixed the relay deploy pipeline.",
    workspaceId: "ws-jb",
    workspaceName: "JellyBot",
    last: 5_000,
  }),
  record({
    id: "h2",
    sessionId: "dead-2",
    summary: "Note editor toolbar polish.",
    workspaceId: "ws-jn",
    workspaceName: "JNote",
    last: 8_000,
  }),
  record({
    id: "h3",
    sessionId: "dead-3",
    summary: "Still summarizing — not done yet.",
    workspaceId: "ws-jb",
    workspaceName: "JellyBot",
    last: 8_500,
    status: "pending",
  }),
  record({
    id: "h4",
    sessionId: "dead-4",
    summary: "greetings only, nothing to keep",
    workspaceId: "ws-jb",
    workspaceName: "JellyBot",
    last: 9_000,
    summarySource: "discarded",
  }),
];

function makeContext(
  overrides: Partial<ToolExecuteContext> = {},
): ToolExecuteContext {
  return {
    workspacePath: "/jb",
    sessionId: "live-1",
    workspaceId: "ws-jb",
    fullPermissionsEnabled: false,
    listAgentSessions: () => [liveSession],
    listWorkspaces: () => [
      { id: "ws-jb", name: "JellyBot" },
      { id: "ws-jn", name: "JNote" },
    ],
    listSessionHistory: () => historyRecords,
    ...overrides,
  };
}

async function text(args: JsonObject): Promise<string> {
  const result = await searchSessionHistoryHandler(args, makeContext());
  const first = result.content[0]!;
  if (first.type !== "text") throw new Error("expected text result");
  return first.text;
}

describe("search_session_history scope", () => {
  it("default scope keeps history out of results", async () => {
    const body = await text({ query: "relay" });
    assert.match(body, /live-1/);
    assert.doesNotMatch(body, /dead-1/);
  });

  it("scope=history searches only summarized records", async () => {
    const body = await text({ query: "relay", scope: "history" });
    assert.match(body, /dead-1/);
    assert.doesNotMatch(body, /live-1/);
    assert.match(body, /archived summary \(activity/);
    // Pending (not yet summarized) rows are invisible.
    assert.doesNotMatch(body, /dead-3/);
  });

  it("scope=all merges live and archive hits newest-first", async () => {
    const body = await text({ scope: "all", limit: 20 });
    const liveAt = body.indexOf("live-1");
    const d2 = body.indexOf("dead-2");
    const d1 = body.indexOf("dead-1");
    assert.ok(liveAt >= 0 && d2 >= 0 && d1 >= 0);
    assert.ok(liveAt < d2 && d2 < d1);
  });

  it("scope=history filters by workspace and time window", async () => {
    const jnote = await text({ scope: "history", workspace: "JNote" });
    assert.match(jnote, /dead-2/);
    assert.doesNotMatch(jnote, /dead-1/);
    // after=7000 excludes dead-1 (last activity 5000).
    const recent = await text({ scope: "history", after: "7000" });
    assert.match(recent, /dead-2/);
    assert.doesNotMatch(recent, /dead-1/);
  });

  it("scope=history works without a live session store", async () => {
    const ctx = makeContext();
    delete ctx.listAgentSessions;
    const result = await searchSessionHistoryHandler(
      { query: "relay", scope: "history" },
      ctx,
    );
    assert.equal(result.returnCode, 0);
    const first = result.content[0]!;
    assert.ok(first.type === "text");
    assert.match(first.text, /dead-1/);
  });

  it("reading a deleted session id returns the archived summary", async () => {
    const body = await text({ mode: "read", session_id: "dead-1" });
    assert.match(body, /Archived session dead-1/);
    assert.match(body, /fixed the relay deploy pipeline\./);
    assert.match(body, /summary by llm/);
  });

  it("LLM-discarded tombstones never surface in search or read", async () => {
    const body = await text({ query: "greetings", scope: "history" });
    assert.doesNotMatch(body, /dead-4/);
    const all = await text({ scope: "history", limit: 20 });
    assert.doesNotMatch(all, /dead-4/);
    const read = await searchSessionHistoryHandler(
      { mode: "read", session_id: "dead-4" },
      makeContext(),
    );
    assert.equal(read.returnCode, 3); // NotFound: tombstone invisible to read
  });

  it("rejects scope in read mode and unknown scope values", async () => {
    const read = await searchSessionHistoryHandler(
      { mode: "read", session_id: "dead-1", scope: "history" },
      makeContext(),
    );
    assert.equal(read.returnCode, 5);
    const bogus = await searchSessionHistoryHandler(
      { query: "x", scope: "bogus" },
      makeContext(),
    );
    assert.equal(bogus.returnCode, 5);
    const first = bogus.content[0]!;
    assert.ok(first.type === "text");
    assert.match(first.text, /scope must be/);
  });
});
