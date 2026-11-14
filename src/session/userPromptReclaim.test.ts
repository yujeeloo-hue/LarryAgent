import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message, MessagePart } from "./types.js";
import { STEER_CONTINUATION_PART_ID } from "./types.js";
import { wrapWireOverlayBody } from "./wireOverlay.js";
import { reclaimableUserMessageId } from "./userPromptReclaim.js";
import { buildDemoConfirmMessage } from "./demoConfirm.js";

function user(id: string, parts: MessagePart[]): Message {
  return { id, role: "user", parts, createdAt: 1 };
}

function assistant(id: string, parts: MessagePart[] = []): Message {
  return { id, role: "assistant", parts, createdAt: 2 };
}

describe("reclaimableUserMessageId", () => {
  it("is the latest user message while the turn runs with no content after it", () => {
    const u1 = user("u1", [{ type: "text", text: "first" }]);
    const u2 = user("u2", [{ type: "text", text: "second" }]);
    assert.equal(
      reclaimableUserMessageId([u1, assistant("a1", [
        { type: "text", text: "done" },
      ]), u2, assistant("a2")], "running"),
      "u2",
    );
  });

  it("is null unless the turn is running", () => {
    const u1 = user("u1", [{ type: "text", text: "hi" }]);
    assert.equal(reclaimableUserMessageId([u1], "running"), "u1");
    assert.equal(reclaimableUserMessageId([u1], "idle"), null);
    assert.equal(reclaimableUserMessageId([u1], "error"), null);
    assert.equal(reclaimableUserMessageId([u1], "cancelled"), null);
  });

  it("stays reclaimable while only reasoning / model_response streamed", () => {
    const u1 = user("u1", [{ type: "text", text: "think about it" }]);
    const a = assistant("a1", [
      { type: "reasoning", text: "hmm" },
      {
        type: "model_response",
        providerScope: "x",
        responseId: "r",
        status: "in_progress",
        stored: false,
        output: [],
      },
    ]);
    assert.equal(reclaimableUserMessageId([u1, a], "running"), "u1");
  });

  it("drops the affordance once visible content landed", () => {
    const u1 = user("u1", [{ type: "text", text: "hi" }]);
    assert.equal(
      reclaimableUserMessageId(
        [u1, assistant("a1", [{ type: "text", text: "answer" }])],
        "running",
      ),
      null,
    );
    const toolCall = { type: "tool_call", id: "t1" } as MessagePart;
    assert.equal(
      reclaimableUserMessageId([u1, assistant("a1", [toolCall])], "running"),
      null,
    );
  });

  it("rejects non-assistant residue after the prompt (error notes)", () => {
    const u1 = user("u1", [{ type: "text", text: "hi" }]);
    const note: Message = {
      id: "s1",
      role: "system",
      createdAt: 3,
      parts: [{ type: "text", text: "boom", error: true }],
    };
    assert.equal(reclaimableUserMessageId([u1, note], "running"), null);
  });

  it("skips the trailing wire-only overlay", () => {
    const u1 = user("u1", [{ type: "text", text: "real prompt" }]);
    const overlay = user("wire", [
      { type: "text", text: wrapWireOverlayBody("overlay") },
    ]);
    assert.equal(reclaimableUserMessageId([u1, overlay], "running"), "u1");
  });

  it("is null when the latest user message is a steer continuation", () => {
    const u1 = user("u1", [{ type: "text", text: "original" }]);
    const steer = user("u2", [
      { type: "text", text: "and also", id: STEER_CONTINUATION_PART_ID },
    ]);
    assert.equal(reclaimableUserMessageId([u1, steer], "running"), null);
  });

  it("is null when the latest user message is a demo confirm card", () => {
    const confirm = user("dc1", [{
      type: "text",
      text: buildDemoConfirmMessage({
        toolCallId: "call_x",
        paramsJson: '{"n": 2}',
        note: "go",
      }),
    }]);
    assert.equal(
      reclaimableUserMessageId([confirm, assistant("a1")], "running"),
      null,
    );
    // A later normal prompt is normally reclaimable again.
    const next = user("u9", [{ type: "text", text: "keep going" }]);
    assert.equal(
      reclaimableUserMessageId(
        [confirm, assistant("a1"), next, assistant("a2")],
        "running",
      ),
      "u9",
    );
  });

  it("accepts attachment-only prompts (attachments restore too)", () => {
    const u1 = user("u1", [
      { type: "attachment", kind: "file", uri: "/a.png", mimeType: "image/png" },
    ]);
    assert.equal(reclaimableUserMessageId([u1], "running"), "u1");
  });
});
