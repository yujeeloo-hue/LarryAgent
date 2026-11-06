import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumeTurnErrorMessage } from "./turnErrorConsume.js";
import type {
  AssistantMessage,
  Session,
  SystemMessage,
  UserMessage,
} from "../session/types.js";

function userMessage(id: string, text: string): UserMessage {
  return {
    id,
    role: "user",
    createdAt: 1,
    parts: [{ type: "text", text }],
  };
}

function emptyAssistant(id: string): AssistantMessage {
  return { id, role: "assistant", createdAt: 2, parts: [] };
}

function textAssistant(id: string, text: string): AssistantMessage {
  return {
    id,
    role: "assistant",
    createdAt: 2,
    parts: [{ type: "text", text }],
  };
}

function errorMessage(id: string, text: string): SystemMessage {
  return {
    id,
    role: "system",
    createdAt: 3,
    parts: [{ type: "text", text, error: true }],
  };
}

function infoMessage(id: string, text: string): SystemMessage {
  return {
    id,
    role: "system",
    createdAt: 3,
    parts: [{ type: "text", text }],
  };
}

function sessionWith(...messages: Session["messages"]): Session {
  return {
    id: "s1",
    type: "agent",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    status: "error",
    progressText: "",
    messages,
    model: "m",
    providerId: "p",
    workspaceId: "w",
    workspacePath: "/w",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
  };
}

describe("consumeTurnErrorMessage", () => {
  it("removes only the error row when the turn produced content", () => {
    const session = sessionWith(
      userMessage("u1", "run tests"),
      textAssistant("a1", "partial output"),
      errorMessage("e1", "upstream 502"),
    );
    const result = consumeTurnErrorMessage(session, "e1");
    assert.deepEqual(result, { removed: true });
    assert.deepEqual(
      session.messages.map((m) => m.id),
      ["u1", "a1"],
    );
  });

  it("keeps a content-free turn's prompt — retry continues instead of resending", () => {
    // Retry now submits a hidden continuation prompt, so the failed turn's
    // user message must stay in the transcript; only the error row goes.
    const session = sessionWith(
      userMessage("u0", "earlier"),
      textAssistant("a0", "done"),
      userMessage("u1", "run tests"),
      emptyAssistant("a1"),
      errorMessage("e1", "connect ECONNREFUSED"),
    );
    const result = consumeTurnErrorMessage(session, "e1");
    assert.deepEqual(result, { removed: true });
    assert.deepEqual(
      session.messages.map((m) => m.id),
      ["u0", "a0", "u1", "a1"],
    );
  });

  it("keeps history when a steer message landed mid-turn", () => {
    const steer: UserMessage = {
      id: "s1",
      role: "user",
      createdAt: 2,
      parts: [
        {
          type: "text",
          id: "turn-continuation:steer",
          text: "also lint",
        },
      ],
    };
    const session = sessionWith(
      userMessage("u1", "run tests"),
      emptyAssistant("a1"),
      steer,
      errorMessage("e1", "Model error"),
    );
    const result = consumeTurnErrorMessage(session, "e1");
    assert.deepEqual(result, { removed: true });
    assert.deepEqual(
      session.messages.map((m) => m.id),
      ["u1", "a1", "s1"],
    );
  });

  it("is idempotent for a missing message id", () => {
    const session = sessionWith(userMessage("u1", "hi"));
    const result = consumeTurnErrorMessage(session, "nope");
    assert.deepEqual(result, { removed: false });
    assert.equal(session.messages.length, 1);
  });

  it("ignores non-error system notes with the same id space", () => {
    const session = sessionWith(
      userMessage("u1", "hi"),
      infoMessage("n1", "Continuing after user pause."),
    );
    const result = consumeTurnErrorMessage(session, "n1");
    assert.deepEqual(result, { removed: false });
    assert.equal(session.messages.length, 2);
  });

  it("removes a standalone error (no user prompt in the turn)", () => {
    const session = sessionWith(
      userMessage("u1", "hi"),
      textAssistant("a1", "done"),
      errorMessage("e1", "Turn handoff failed to start: boom"),
    );
    const result = consumeTurnErrorMessage(session, "e1");
    assert.deepEqual(result, { removed: true });
    assert.deepEqual(
      session.messages.map((m) => m.id),
      ["u1", "a1"],
    );
  });

  it("removes legacy-prefix error rows persisted before the error flag", () => {
    // Rows written before TextPart.error existed carry only the push-site
    // prefix. The renderer still offers Retry on them (isTurnErrorTextPart
    // matches the prefix), so consume must remove them too — otherwise the
    // row (and its Retry pill) resurfaces on every conversation re-entry.
    const legacy: SystemMessage = {
      id: "e1",
      role: "system",
      createdAt: 3,
      parts: [
        { type: "text", text: "Queued message could not start a turn: boom" },
      ],
    };
    const session = sessionWith(
      userMessage("u1", "hi"),
      textAssistant("a1", "done"),
      legacy,
    );
    const result = consumeTurnErrorMessage(session, "e1");
    assert.deepEqual(result, { removed: true });
    assert.deepEqual(
      session.messages.map((m) => m.id),
      ["u1", "a1"],
    );
  });
});
