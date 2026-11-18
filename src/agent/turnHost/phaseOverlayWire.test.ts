import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isWireOverlayTranscriptMessage,
  wrapWireOverlayBody,
} from "../../session/wireOverlay.js";
import {
  assembleModelFacingMessages,
  ensureWireUserMessage,
  NO_USER_WINDOW_PLACEHOLDER,
  peelTrailingPhaseOverlay,
  phaseOverlayMessages,
} from "./phaseOverlayWire.js";

describe("phaseOverlayWire", () => {
  it("assembles overlay after conversation", () => {
    const messages = assembleModelFacingMessages({
      systemPrefix: [{ role: "system", content: "ID" }],
      conversation: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
      phaseOverlay: "[Execute phase]\nCurrent step: 1",
    });
    assert.equal(messages.length, 4);
    assert.equal(messages[0]!.content, "ID");
    assert.equal(messages[3]!.role, "user");
    assert.match(String(messages[3]!.content), /Current step/);
    assert.match(
      String(messages[3]!.content),
      /Role overlay — ephemeral, not from the user/,
    );
  });

  it("omits empty overlay", () => {
    assert.deepEqual(phaseOverlayMessages("  "), []);
    const messages = assembleModelFacingMessages({
      systemPrefix: [{ role: "system", content: "ID" }],
      conversation: [{ role: "user", content: "hi" }],
      phaseOverlay: "",
    });
    assert.equal(messages.length, 2);
  });

  it("seeds a wire-only user placeholder when the window has no user", () => {
    const messages = assembleModelFacingMessages({
      systemPrefix: [{ role: "system", content: "You are CoCo greeting the user." }],
      conversation: [],
      phaseOverlay: "",
    });
    assert.deepEqual(messages.map((m) => m.role), ["system", "user"]);
    assert.equal(messages[1]!.content, NO_USER_WINDOW_PLACEHOLDER);
    assert.match(NO_USER_WINDOW_PLACEHOLDER, /not from the user/);
  });

  it("puts the placeholder before a truncated assistant/tool suffix", () => {
    const messages = ensureWireUserMessage([
      { role: "system", content: "ID" },
      { role: "assistant", content: "calling" },
      { role: "tool", content: "ok", tool_call_id: "t1" },
    ] as Parameters<typeof ensureWireUserMessage>[0]);
    assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  });

  it("never duplicates the placeholder when a user already exists", () => {
    const messages = assembleModelFacingMessages({
      systemPrefix: [{ role: "system", content: "ID" }],
      conversation: [{ role: "user", content: "hi" }],
      phaseOverlay: "",
    });
    assert.equal(messages.filter((m) => m.content === NO_USER_WINDOW_PLACEHOLDER).length, 0);
    assert.deepEqual(ensureWireUserMessage(messages), messages);
  });

  it("peels trailing overlay so callers can re-append last", () => {
    const overlay = "[Execute phase]";
    const built = assembleModelFacingMessages({
      systemPrefix: [{ role: "system", content: "ID" }],
      conversation: [{ role: "user", content: "hi" }],
      phaseOverlay: overlay,
    });
    const { stem, tail } = peelTrailingPhaseOverlay(built, overlay);
    assert.equal(stem.length, 2);
    assert.equal(tail.length, 1);
    assert.deepEqual(
      [...stem, { role: "user", content: "instr" }, ...tail].map((m) => m.role),
      ["system", "user", "user", "user"],
    );
    assert.equal(tail[0]!.role, "user");
  });

  it("marks overlay so the transcript UI can skip it", () => {
    const overlay = phaseOverlayMessages("[PLANNER]\nDecide.");
    assert.equal(
      isWireOverlayTranscriptMessage({
        role: "user",
        parts: [{ type: "text", text: String(overlay[0]!.content) }],
      }),
      true,
    );
    assert.equal(
      isWireOverlayTranscriptMessage({
        role: "user",
        parts: [{ type: "text", text: "Please write the plan." }],
      }),
      false,
    );
    assert.equal(
      wrapWireOverlayBody("[PLANNER]").startsWith(
        "[Role overlay — ephemeral, not from the user]",
      ),
      true,
    );
  });
});
