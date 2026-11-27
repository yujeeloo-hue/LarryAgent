import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ContextClearPart,
  ContextNewTaskPart,
  Message,
} from "../../../../session/types.js";
import {
  findLatestModelWindowFloor,
  messagesAfterModelWindowFloor,
} from "../../messagesToOpenAi.js";
import { buildModelMessages } from "./messagesToOpenAi.js";

function user(id: string, text: string): Message {
  return { id, role: "user", parts: [{ type: "text", text }], createdAt: 1 };
}

function assistant(id: string, text: string): Message {
  return { id, role: "assistant", parts: [{ type: "text", text }], createdAt: 1 };
}

function newTaskMarker(id: string): Message {
  const part: ContextNewTaskPart = {
    type: "context_new_task",
    id: `${id}-part`,
    reason: "unrelated_prompt",
    hiddenMessageCount: 4,
  };
  return { id, role: "system", parts: [part], createdAt: 2 };
}

function clearMarker(id: string): Message {
  const part: ContextClearPart = {
    type: "context_clear",
    id: `${id}-part`,
    clearedMessageCount: 4,
  };
  return { id, role: "system", parts: [part], createdAt: 2 };
}

function wireTexts(wire: { role: string; content: unknown }[]): string {
  return wire.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

describe("model window floor (New Task + /clear)", () => {
  it("hides everything above the New Task marker", () => {
    const messages = [
      user("u1", "Request one"),
      assistant("a1", "Answer one"),
      newTaskMarker("boundary"),
      user("u2", "Request two"),
      assistant("a2", "Answer two"),
    ];
    const text = wireTexts(buildModelMessages(messages));
    assert.doesNotMatch(text, /Request one|Answer one/);
    assert.match(text, /Request two/);
    assert.match(text, /Answer two/);
  });

  it("uses only the latest of /clear and New Task", () => {
    const messages = [
      user("u1", "Request one"),
      clearMarker("clear"),
      user("u2", "Request two"),
      newTaskMarker("boundary"),
      user("u3", "Request three"),
    ];
    assert.equal(findLatestModelWindowFloor(messages), 3);
    const text = wireTexts(buildModelMessages(messages));
    assert.doesNotMatch(text, /Request one|Request two/);
    assert.match(text, /Request three/);
  });

  it("keeps the whole transcript when neither marker exists", () => {
    const messages = [user("u1", "Request one"), assistant("a1", "Answer one")];
    assert.equal(findLatestModelWindowFloor(messages), -1);
    assert.equal(messagesAfterModelWindowFloor(messages).length, 2);
    assert.match(wireTexts(buildModelMessages(messages)), /Request one/);
  });

  it("renders nothing when the boundary is the newest message", () => {
    const messages = [user("u1", "Request one"), newTaskMarker("boundary")];
    assert.equal(buildModelMessages(messages).length, 0);
  });
});
