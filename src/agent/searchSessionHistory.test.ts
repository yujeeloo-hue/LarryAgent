import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatSessionHistoryHits,
  formatSessionHistoryRead,
  MAX_RESULT_CHARS,
  mergeSessionHistoryHits,
  parseTimeBound,
  readSessionHistory,
  searchSessionHistory,
  splitSearchKeywords,
  truncateSessionHistoryResult,
  type SessionHistoryHit,
} from "./searchSessionHistory.js";
import type { Message, Session } from "../session/types.js";

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
): Message {
  if (role === "user") {
    return {
      id,
      role: "user",
      parts: [{ type: "text", text }],
      createdAt,
    };
  }
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    createdAt,
  };
}

function session(partial: {
  id: string;
  title: string;
  workspaceId: string;
  messages: Message[];
  updatedAt?: number;
}): Session {
  return {
    id: partial.id,
    type: "agent",
    title: partial.title,
    createdAt: 1,
    updatedAt: partial.updatedAt ?? 100,
    status: "idle",
    progressText: "",
    messages: partial.messages,
    model: "m",
    providerId: "p",
    workspaceId: partial.workspaceId,
    workspacePath: "/tmp/ws",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
  };
}

describe("searchSessionHistory", () => {
  const s1 = session({
    id: "s1",
    title: "Fix login bug",
    workspaceId: "ws1",
    updatedAt: 300,
    messages: [
      msg("m1", "user", "please fix the login timeout", 100),
      msg("m2", "assistant", "I will inspect auth.ts", 110),
      msg("m3", "user", "also check cookies", 200),
    ],
  });
  const s2 = session({
    id: "s2",
    title: "Unrelated",
    workspaceId: "ws1",
    updatedAt: 400,
    messages: [msg("n1", "user", "deploy the website", 350)],
  });
  const otherWs = session({
    id: "s3",
    title: "Other workspace login",
    workspaceId: "ws2",
    messages: [msg("o1", "user", "login timeout here too", 500)],
  });

  it("splits keywords on whitespace and commas", () => {
    assert.deepEqual(splitSearchKeywords("login, timeout  cookies"), [
      "login",
      "timeout",
      "cookies",
    ]);
  });

  it("AND-matches keywords across workspace sessions", () => {
    const hits = searchSessionHistory({
      sessions: [s1, s2, otherWs],
      currentSessionId: "s1",
      workspaceId: "ws1",
      query: "login timeout",
    });
    assert.ok(hits.some((h) => h.sessionId === "s1" && h.messageId === "m1"));
    assert.ok(!hits.some((h) => h.sessionId === "s2"));
    assert.ok(!hits.some((h) => h.sessionId === "s3"));
  });

  it("filters by time bounds", () => {
    const hits = searchSessionHistory({
      sessions: [s1, s2],
      currentSessionId: "s1",
      workspaceId: "ws1",
      afterMs: 150,
      beforeMs: 250,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.messageId, "m3");
  });

  it("scopes to current session", () => {
    const hits = searchSessionHistory({
      sessions: [s1, s2],
      currentSessionId: "s1",
      workspaceId: "ws1",
      sessionId: "current",
      query: "login",
    });
    assert.ok(hits.every((h) => h.sessionId === "s1"));
  });

  it("searches across all workspaces when workspaceId is unset", () => {
    const hits = searchSessionHistory({
      sessions: [s1, s2, otherWs],
      currentSessionId: "s1",
      query: "login timeout",
    });
    assert.ok(hits.some((h) => h.sessionId === "s1" && h.messageId === "m1"));
    assert.ok(hits.some((h) => h.sessionId === "s3" && h.messageId === "o1"));
    assert.ok(!hits.some((h) => h.sessionId === "s2"));
  });

  it("labels cross-workspace hits with workspace names", () => {
    const hits = searchSessionHistory({
      sessions: [s1, otherWs],
      currentSessionId: "s1",
      query: "login timeout",
      workspaceNames: new Map([
        ["ws1", "JellyBot"],
        ["ws2", "JNote"],
      ]),
    });
    assert.equal(hits.find((h) => h.sessionId === "s1")?.workspaceName, "JellyBot");
    assert.equal(hits.find((h) => h.sessionId === "s3")?.workspaceName, "JNote");
    const text = formatSessionHistoryHits(hits);
    assert.match(text, /workspace="JellyBot"/);
    assert.match(text, /workspace="JNote"/);
    assert.match(text, /workspace="current"/);
  });

  it("falls back to raw workspace id when no name map is given", () => {
    const hits = searchSessionHistory({
      sessions: [otherWs],
      currentSessionId: "s1",
      query: "login",
    });
    assert.equal(hits[0]?.workspaceName, "ws2");
  });

  it("reads a session from another workspace under all scope", () => {
    const result = readSessionHistory({
      sessions: [s1, otherWs],
      currentSessionId: "s1",
      sessionId: "s3",
      workspaceNames: new Map([["ws2", "JNote"]]),
    });
    assert.ok(result);
    assert.equal(result!.sessionId, "s3");
    assert.equal(result!.workspaceName, "JNote");
    assert.match(formatSessionHistoryRead(result!), /workspace "JNote"/);
  });

  it("reads a message window", () => {
    const result = readSessionHistory({
      sessions: [s1],
      currentSessionId: "s1",
      workspaceId: "ws1",
      sessionId: "current",
      aroundMessageId: "m2",
      beforeCount: 1,
      afterCount: 1,
    });
    assert.ok(result);
    assert.deepEqual(
      result!.messages.map((m) => m.messageId),
      ["m1", "m2", "m3"],
    );
  });

  it("parses ISO and epoch time bounds", () => {
    assert.equal(parseTimeBound("1700000000000"), 1700000000000);
    assert.ok(parseTimeBound("2024-01-15T12:00:00.000Z")! > 0);
    assert.equal(parseTimeBound("nope"), null);
  });

  it("formats empty search", () => {
    assert.match(formatSessionHistoryHits([]), /No matching/);
  });

  it("truncates oversized formatted results", () => {
    const big = "x".repeat(MAX_RESULT_CHARS + 500);
    const out = truncateSessionHistoryResult(big);
    assert.ok(out.length <= MAX_RESULT_CHARS + 120);
    assert.match(out, /truncated: result capped/);
  });
});

describe("mergeSessionHistoryHits (scope=all dedup)", () => {
  function hit(
    sessionId: string,
    createdAt: number,
    matchKind: SessionHistoryHit["matchKind"],
  ): SessionHistoryHit {
    return {
      sessionId,
      sessionTitle: `T-${sessionId}`,
      workspaceId: "ws1",
      workspaceName: "ws1",
      messageId: "",
      role: matchKind === "history_summary" ? "summary" : "user",
      createdAt,
      snippet: "snippet",
      matchKind,
    };
  }

  it("drops archive hits for sessions that still have a live hit", () => {
    const merged = mergeSessionHistoryHits(
      [hit("live", 200, "message")],
      [hit("live", 190, "history_summary"), hit("gone", 180, "history_summary")],
      12,
    );
    // The still-live session shows once (its live hit), the deleted
    // session's summary surfaces.
    assert.deepEqual(
      merged.map((h) => [h.sessionId, h.matchKind]),
      [
        ["live", "message"],
        ["gone", "history_summary"],
      ],
    );
  });

  it("keeps archive hits when no live hit matches the same session", () => {
    const merged = mergeSessionHistoryHits(
      [hit("other", 200, "message")],
      [hit("gone", 180, "history_summary")],
      12,
    );
    assert.equal(merged.length, 2);
    assert.ok(merged.some((h) => h.matchKind === "history_summary"));
  });
});
