import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message, MessagePart } from "../session/types.js";
import { RETRY_CONTINUATION_PART_ID } from "../session/types.js";
import { splitConversationTurns } from "./contextCompaction/conversationTurns.js";
import {
  isRetryContinuation,
  isSteerContinuation,
  markPartsAsRetryContinuation,
  markPartsAsSteerContinuation,
  RETRY_CONTINUATION_PROMPT,
} from "./turnContinuations.js";

function user(id: string, text: string, createdAt: number): Message {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    createdAt,
  };
}

describe("steer turn continuations", () => {
  it("persists the marker on user parts", () => {
    const parts: MessagePart[] = [{ type: "text", text: "Change direction" }];
    markPartsAsSteerContinuation(parts);
    const message: Message = {
      id: "steer",
      role: "user",
      parts,
      createdAt: 2,
    };
    assert.equal(isSteerContinuation(message), true);
  });

  it("keeps a steering user message inside the original Turn", () => {
    const first = user("u1", "Build it", 1);
    const steer = user("u2", "Use SQLite instead", 3);
    markPartsAsSteerContinuation(steer.parts);
    const messages: Message[] = [
      first,
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Working" }],
        createdAt: 2,
      },
      steer,
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "Corrected" }],
        createdAt: 4,
      },
    ];

    const turns = splitConversationTurns(messages);
    assert.equal(turns.length, 1);
    assert.deepEqual(
      turns[0]?.messages.map((message) => message.id),
      ["u1", "a1", "u2", "a2"],
    );
  });
});

describe("retry turn continuations", () => {
  it("stamps the first text part in place", () => {
    const parts: MessagePart[] = [{ type: "text", text: "continue the task" }];
    markPartsAsRetryContinuation(parts);
    assert.equal((parts[0] as { id?: string }).id, RETRY_CONTINUATION_PART_ID);
    assert.equal((parts[0] as { text: string }).text, "continue the task");
  });

  it("prepends an empty marker part when there is no text", () => {
    const parts: MessagePart[] = [];
    markPartsAsRetryContinuation(parts);
    assert.equal(parts.length, 1);
    assert.equal((parts[0] as { id?: string }).id, RETRY_CONTINUATION_PART_ID);
  });

  it("matches only user messages carrying the marker", () => {
    assert.equal(
      isRetryContinuation({
        id: "c1",
        role: "user",
        createdAt: 1,
        parts: [{ type: "text", text: "go", id: RETRY_CONTINUATION_PART_ID }],
      }),
      true,
    );
    assert.equal(isRetryContinuation(user("u1", "go", 1)), false);
    const assistant: Message = {
      id: "a1",
      role: "assistant",
      createdAt: 1,
      parts: [{ type: "text", text: "go", id: RETRY_CONTINUATION_PART_ID }],
    };
    assert.equal(isRetryContinuation(assistant), false);
    assert.equal(isSteerContinuation(assistant), false);
  });

  it("marker and prompt are distinct from the steer family", () => {
    assert.notEqual(RETRY_CONTINUATION_PART_ID, "turn-continuation:steer");
    assert.ok(RETRY_CONTINUATION_PROMPT.length > 0);
    assert.match(RETRY_CONTINUATION_PROMPT, /continue/i);
  });
});
