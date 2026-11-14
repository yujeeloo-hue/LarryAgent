import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMissingApiKeyError,
  isTurnErrorMessage,
  isTurnErrorTextPart,
  turnErrorRetryPayloadsByMessageId,
  turnErrorTitle,
} from "./TurnErrorCardView.js";

type MessageLike = {
  id?: string;
  role: string;
  parts: Array<Record<string, unknown>>;
};

describe("isMissingApiKeyError", () => {
  it("matches the main-process missing-key copy variants", () => {
    assert.equal(
      isMissingApiKeyError(
        'Missing API key for provider "DeepSeek". Add it in Setting or .env JELLYBOT_API_KEY.',
      ),
      true,
    );
    assert.equal(
      isMissingApiKeyError('Missing API key for provider "OpenAI"'),
      true,
    );
    assert.equal(
      isMissingApiKeyError('Missing API key for provider "Kimi". Add it in Setting.'),
      true,
    );
  });

  it("matches queue/handoff wrappers that embed the raw message", () => {
    assert.equal(
      isMissingApiKeyError(
        'Queued message could not start a turn: Missing API key for provider "X"',
      ),
      true,
    );
  });

  it("rejects other failures", () => {
    assert.equal(isMissingApiKeyError("Request failed after 3 retries"), false);
    assert.equal(isMissingApiKeyError("HTTP 401 Unauthorized"), false);
    assert.equal(isMissingApiKeyError(""), false);
  });
});

describe("isTurnErrorTextPart", () => {
  it("accepts the explicit error marker", () => {
    assert.equal(
      isTurnErrorTextPart({ type: "text", text: "upstream 502", error: true }),
      true,
    );
  });

  it("matches legacy persisted error prefixes", () => {
    assert.equal(
      isTurnErrorTextPart({
        type: "text",
        text: "Queued message could not start a turn: boom",
      }),
      true,
    );
    assert.equal(
      isTurnErrorTextPart({
        type: "text",
        text: "Turn handoff failed to start: boom",
      }),
      true,
    );
  });

  it("rejects informational system notes", () => {
    assert.equal(
      isTurnErrorTextPart({ type: "text", text: "Continuing after user pause." }),
      false,
    );
    assert.equal(
      isTurnErrorTextPart({
        type: "text",
        text: "Turn handoff dropped: new user input arrived.",
      }),
      false,
    );
    assert.equal(
      isTurnErrorTextPart({ type: "reasoning", text: "..." }),
      false,
    );
  });
});

describe("isTurnErrorMessage", () => {
  it("only classifies system messages", () => {
    assert.equal(
      isTurnErrorMessage({
        role: "system",
        parts: [{ type: "text", text: "x", error: true }],
      }),
      true,
    );
    assert.equal(
      isTurnErrorMessage({
        role: "assistant",
        parts: [{ type: "text", text: "x", error: true }],
      }),
      false,
    );
  });
});

describe("turnErrorTitle", () => {
  it("differentiates by failure source", () => {
    assert.equal(
      turnErrorTitle("Queued message could not start a turn: boom"),
      "Queued prompt failed",
    );
    assert.equal(
      turnErrorTitle("Turn handoff failed to start: boom"),
      "Handoff failed",
    );
    assert.equal(turnErrorTitle("Request failed after 3 retries"), "Turn failed");
  });
});

describe("turnErrorRetryPayloadsByMessageId", () => {
  it("keys a hidden continuation payload by each error id in the turn", () => {
    const turn: MessageLike[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      { id: "a1", role: "assistant", parts: [] },
      { id: "e1", role: "system", parts: [{ type: "text", text: "502", error: true }] },
    ];
    const map = turnErrorRetryPayloadsByMessageId(turn);
    assert.deepEqual([...map.keys()], ["e1"]);
    // Retry continues the task with a hidden prompt — the original prompt
    // text must NOT travel in the payload (nothing is resent).
    assert.deepEqual(map.get("e1"), {
      continuation: "retry",
      errorMessageId: "e1",
    });
  });

  it("yields nothing for a turn without a leading user message", () => {
    const turn: MessageLike[] = [
      { id: "e1", role: "system", parts: [{ type: "text", text: "502", error: true }] },
    ];
    assert.equal(turnErrorRetryPayloadsByMessageId(turn).size, 0);
  });

  it("ignores non-error system rows in the same turn", () => {
    const turn: MessageLike[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      { id: "n1", role: "system", parts: [{ type: "text", text: "note" }] },
    ];
    assert.equal(turnErrorRetryPayloadsByMessageId(turn).size, 0);
  });
});
