/**
 * /clear projection (iterationProtectV1 twin): the last context_clear
 * marker restarts the model window; earlier turns and summaries are
 * hidden. No marker → behavior unchanged.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ContextClearPart,
  ContextCompactionPart,
  Message,
} from "../../../../session/types.js";
import { buildModelMessages } from "./messagesToOpenAi.js";

function user(id: string, text: string): Message {
  return { id, role: "user", parts: [{ type: "text", text }], createdAt: 1 };
}

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    createdAt: 1,
  };
}

function clearMarker(id: string): Message {
  const part: ContextClearPart = {
    type: "context_clear",
    id: `${id}-part`,
    clearedMessageCount: 4,
  };
  return { id, role: "system", parts: [part], createdAt: 2 };
}

function compactionMarker(summary: string): Message {
  const part: ContextCompactionPart = {
    type: "context_compaction",
    id: "compaction-part",
    summary,
    fromMessageId: "u1",
    toMessageId: "a1",
    usedTokensBefore: 100_000,
    usedTokensAfter: 20_000,
  };
  return { id: "compaction", role: "system", parts: [part], createdAt: 2 };
}

function wireTexts(
  wire: { role: string; content: unknown }[],
): string {
  return wire
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

describe("iterationProtectV1 buildModelMessages /clear", () => {
  it("renders everything when no clear marker exists (regression anchor)", () => {
    const messages = [
      user("u1", "Request one"),
      assistant("a1", "Answer one"),
      user("u2", "Request two"),
    ];
    const text = wireTexts(buildModelMessages(messages));
    assert.match(text, /Request one/);
    assert.match(text, /Request two/);
  });

  it("hides every message and summary before the clear marker", () => {
    const messages = [
      user("u1", "Request one"),
      assistant("a1", "Answer one"),
      compactionMarker("Old rolling summary."),
      clearMarker("clear"),
      user("u2", "Request two"),
      assistant("a2", "Answer two"),
    ];
    const text = wireTexts(buildModelMessages(messages));
    assert.doesNotMatch(text, /Old rolling summary/);
    assert.doesNotMatch(text, /Request one|Answer one/);
    assert.match(text, /Request two/);
    assert.match(text, /Answer two/);
  });

  it("renders an empty window when the clear marker is last", () => {
    const messages = [
      user("u1", "Request one"),
      clearMarker("clear"),
    ];
    assert.equal(buildModelMessages(messages).length, 0);
  });

  it("uses only the latest clear marker", () => {
    const messages = [
      user("u1", "Request one"),
      clearMarker("clear1"),
      user("u2", "Request two"),
      clearMarker("clear2"),
      user("u3", "Request three"),
    ];
    const text = wireTexts(buildModelMessages(messages));
    assert.doesNotMatch(text, /Request one|Request two/);
    assert.match(text, /Request three/);
  });
});
