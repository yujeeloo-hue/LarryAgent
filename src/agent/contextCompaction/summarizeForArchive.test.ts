import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  summarizeSessionForArchive,
  type SummarizeSessionForArchiveInput,
} from "./summarizeForArchive.js";
import type { Message } from "../../session/types.js";
import type { OpenAiCompatibleClientConfig } from "../../llm/types.js";

const client: OpenAiCompatibleClientConfig = {
  baseUrl: "https://x.test",
  apiKey: "k",
  model: "test-model",
};

function userMsg(id: string, text: string, at = 1): Message {
  return { id, role: "user", parts: [{ type: "text", text }], createdAt: at };
}

function assistantMsg(id: string, text: string, at = 2): Message {
  return { id, role: "assistant", parts: [{ type: "text", text }], createdAt: at };
}

function markerMsg(summary: string, coveredThrough: string): Message {
  return {
    id: "mk",
    role: "system",
    parts: [
      {
        type: "context_compaction",
        id: "cp1",
        summary,
        fromMessageId: "u1",
        toMessageId: coveredThrough,
        usedTokensBefore: 1000,
        usedTokensAfter: 300,
        coveredThroughMessageId: coveredThrough,
      },
    ],
    createdAt: 3,
  };
}

/** Records prompts; returns configured content (or throws). */
function makeSummarize(
  content: string,
  prompts: string[],
): NonNullable<SummarizeSessionForArchiveInput["summarize"]> {
  return async (_client, req) => {
    const first = req.messages[0]!;
    prompts.push(String(first.content));
    return { content };
  };
}

describe("summarizeSessionForArchive", () => {
  it("returns empty for a session with no messages (no LLM call)", async () => {
    const prompts: string[] = [];
    const result = await summarizeSessionForArchive({
      messages: [],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: makeSummarize("unused", prompts),
    });
    assert.deepEqual(result, { kind: "empty" });
    assert.equal(prompts.length, 0);
  });

  it("summarizes a fresh session with SESSION TURNS framing", async () => {
    const prompts: string[] = [];
    const result = await summarizeSessionForArchive({
      messages: [
        userMsg("u1", "fix the login redirect loop"),
        assistantMsg("a1", "patched auth.ts"),
      ],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: makeSummarize("SUM", prompts),
    });
    assert.equal(result.kind, "summarized");
    if (result.kind !== "summarized") return;
    assert.equal(result.summary, "SUM");
    assert.equal(result.inputTruncated, false);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /SESSION TURNS:/);
    assert.doesNotMatch(prompts[0]!, /PREVIOUS SUMMARY/);
    assert.match(prompts[0]!, /login redirect loop/);
  });

  it("merges previous compaction summary with uncovered turns", async () => {
    const prompts: string[] = [];
    const result = await summarizeSessionForArchive({
      messages: [
        userMsg("u1", "old request"),
        assistantMsg("a1", "old answer"),
        markerMsg("Earlier relay work summary.", "a1"),
        userMsg("u2", "deploy relay on the new server"),
        assistantMsg("a2", "deployed"),
      ],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: makeSummarize("MERGED", prompts),
    });
    assert.equal(result.kind, "summarized");
    assert.equal(prompts.length, 1);
    const prompt = prompts[0]!;
    assert.match(prompt, /PREVIOUS SUMMARY/);
    assert.match(prompt, /Earlier relay work summary\./);
    assert.match(prompt, /REMAINING TURNS/);
    assert.match(prompt, /deploy relay on the new server/);
    // Already-covered turns must not re-enter the payload.
    assert.doesNotMatch(prompt, /old request/);
  });

  it("reuses the existing summary when the marker covers everything", async () => {
    const prompts: string[] = [];
    const result = await summarizeSessionForArchive({
      messages: [
        userMsg("u1", "old request"),
        assistantMsg("a1", "old answer"),
        markerMsg("Complete coverage summary.", "a1"),
      ],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: makeSummarize("SHOULD_NOT_CALL", prompts),
    });
    assert.equal(result.kind, "summarized");
    if (result.kind !== "summarized") return;
    assert.equal(result.summary, "Complete coverage summary.");
    assert.equal(result.inputTruncated, false);
    assert.equal(prompts.length, 0);
  });

  it("flags inputTruncated when the payload exceeds the context limit", async () => {
    const prompts: string[] = [];
    const big = "x".repeat(60_000);
    const result = await summarizeSessionForArchive({
      messages: [userMsg("u1", big)],
      sessionId: "s1",
      client,
      contextLimitTokens: 200,
      summarize: makeSummarize("SUM", prompts),
    });
    assert.equal(result.kind, "summarized");
    if (result.kind !== "summarized") return;
    assert.equal(result.inputTruncated, true);
  });

  it("throws on empty LLM content (no deterministic fallback)", async () => {
    await assert.rejects(
      summarizeSessionForArchive({
        messages: [userMsg("u1", "hi")],
        sessionId: "s1",
        client,
        contextLimitTokens: 100_000,
        summarize: async () => ({ content: "   " }),
      }),
      /empty content/,
    );
  });

  it("returns discarded with the reason on an exact NO_ARCHIVE verdict", async () => {
    const result = await summarizeSessionForArchive({
      messages: [
        userMsg("u1", "hi there"),
        assistantMsg("a1", "hello! how can I help?"),
      ],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: async () => ({ content: "NO_ARCHIVE: pure greetings, no work" }),
    });
    assert.deepEqual(result, {
      kind: "discarded",
      reason: "pure greetings, no work",
    });
  });

  it("returns discarded with an empty reason for a bare NO_ARCHIVE", async () => {
    const result = await summarizeSessionForArchive({
      messages: [userMsg("u1", "test"), assistantMsg("a1", "ok")],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: async () => ({ content: "  NO_ARCHIVE  " }),
    });
    assert.deepEqual(result, { kind: "discarded", reason: "" });
  });

  it("treats a mid-body or lowercase sentinel as summary content", async () => {
    const midBody = await summarizeSessionForArchive({
      messages: [userMsg("u1", "fix bug"), assistantMsg("a1", "done")],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: async () => ({
        content: "Fixed the bug.\nNO_ARCHIVE: should not count mid-body",
      }),
    });
    assert.equal(midBody.kind, "summarized");
    if (midBody.kind !== "summarized") return;
    assert.match(midBody.summary, /^Fixed the bug\./);

    const lower = await summarizeSessionForArchive({
      messages: [userMsg("u1", "fix bug"), assistantMsg("a1", "done")],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: async () => ({ content: "no_archive: lowercase is not a verdict" }),
    });
    assert.equal(lower.kind, "summarized");
  });

  it("throws when the model sends NO_ARCHIVE despite a previous summary", async () => {
    await assert.rejects(
      summarizeSessionForArchive({
        messages: [
          userMsg("u1", "old request"),
          assistantMsg("a1", "old answer"),
          markerMsg("Earlier real work summary.", "a1"),
          userMsg("u2", "more work"),
          assistantMsg("a2", "done"),
        ],
        sessionId: "s1",
        client,
        contextLimitTokens: 100_000,
        summarize: async () => ({ content: "NO_ARCHIVE: misfired" }),
      }),
      /NO_ARCHIVE despite a previous summary/,
    );
  });

  it("offers the discard option on fresh sessions, disables it on merge", async () => {
    const freshPrompts: string[] = [];
    await summarizeSessionForArchive({
      messages: [userMsg("u1", "hi"), assistantMsg("a1", "hello")],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: makeSummarize("SUM", freshPrompts),
    });
    assert.match(freshPrompts[0]!, /NO_ARCHIVE: <one-line reason>/);

    const mergePrompts: string[] = [];
    await summarizeSessionForArchive({
      messages: [
        userMsg("u1", "old request"),
        assistantMsg("a1", "old answer"),
        markerMsg("Earlier summary.", "a1"),
        userMsg("u2", "new work"),
        assistantMsg("a2", "done"),
      ],
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: makeSummarize("MERGED", mergePrompts),
    });
    assert.match(mergePrompts[0]!, /does NOT apply here/);
  });

  it("does not mutate the input transcript (no marker written)", async () => {
    const messages = [
      userMsg("u1", "a"),
      assistantMsg("a1", "b"),
      markerMsg("S.", "a1"),
      userMsg("u2", "c"),
    ];
    const before = JSON.stringify(messages);
    await summarizeSessionForArchive({
      messages,
      sessionId: "s1",
      client,
      contextLimitTokens: 100_000,
      summarize: makeSummarize("SUM", []),
    });
    assert.equal(JSON.stringify(messages), before);
  });
});
