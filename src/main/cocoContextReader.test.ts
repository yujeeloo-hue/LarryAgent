import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message, Session } from "../session/types.js";
import { TRANSCRIPT_BUDGET_CHARS, reviewTranscript } from "./cocoContextReader.js";
import type { SessionStore } from "./sessionRuntime.js";

function storeWith(messages: Message[]): SessionStore {
  const session = { id: "s1", title: "Handover", status: "idle", progressText: "", workspaceId: "w1", createdAt: 1, updatedAt: 2, plan: null, messages } as unknown as Session;
  return { getSessionTail: () => ({ session, window: { firstMessageId: messages[0]?.id ?? null, hasMore: false, remainingTurns: 0 } }) } as unknown as SessionStore;
}

describe("reviewTranscript", () => {
  it("clips tool output, drops reasoning and keeps the newest messages within budget", () => {
    const huge = "x".repeat(2_000_000);
    const messages: Message[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push({ id: `u${i}`, role: "user", createdAt: i, parts: [{ type: "text", text: `ask ${i}` }] });
      messages.push({ id: `a${i}`, role: "assistant", createdAt: i, parts: [
        { type: "reasoning", text: huge },
        { type: "tool_call", id: `c${i}`, name: "read_file", status: "done", arguments: { content: huge }, argumentsRaw: JSON.stringify({ content: huge }) },
      ] });
      messages.push({ id: `t${i}`, role: "tool", toolCallId: `c${i}`, createdAt: i, parts: [{ type: "tool_result", toolCallId: `c${i}`, returnCode: 0, content: [{ type: "text", text: huge }] }] });
    }
    const result = reviewTranscript(storeWith(messages), "s1", 3);
    assert.ok(result);
    const text = JSON.stringify(result);
    assert.ok(text.length < TRANSCRIPT_BUDGET_CHARS + 5_000, `projection is ${text.length} chars`);
    assert.ok(!text.includes("\"reasoning\""));
    assert.equal(result.session.messages.at(-1)?.id, "t39");
    assert.ok((result.window.omittedMessages ?? 0) > 0);
  });

  it("returns null for an unknown session", () => {
    const store = { getSessionTail: () => null } as unknown as SessionStore;
    assert.equal(reviewTranscript(store, "missing", 3), null);
  });
});
