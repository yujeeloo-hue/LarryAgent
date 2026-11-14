import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAnimatedProgressText,
  shouldShowTurnProgress,
} from "./turnProgress.js";

describe("turn progress", () => {
  it("animates Planning / Gathering / Reviewing", () => {
    assert.equal(isAnimatedProgressText("Planning…"), true);
    assert.equal(isAnimatedProgressText("Gathering context…"), true);
    assert.equal(isAnimatedProgressText("Reviewing plan…"), true);
    assert.equal(isAnimatedProgressText("Replanning…"), true);
  });

  it("animates Uploading image… (pre-turn attachment upload)", () => {
    assert.equal(isAnimatedProgressText("Uploading image…"), true);
    assert.equal(isAnimatedProgressText("uploading"), true);
    assert.equal(isAnimatedProgressText("Loaded…"), false);
  });

  it("hides the status row only while tokens are streaming", () => {
    const messages = [
      { role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ];
    assert.equal(
      shouldShowTurnProgress({
        progressText: "Planning…",
        messages,
        sessionStatus: "running",
        isLocallyStreaming: true,
      }),
      false,
    );
    assert.equal(
      shouldShowTurnProgress({
        progressText: "Planning…",
        messages,
        sessionStatus: "running",
        isLocallyStreaming: false,
      }),
      true,
    );
  });

  it("overrideActive shows host-driven work on idle sessions", () => {
    const messages = [
      { role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ];
    // Idle session without the override stays hidden (pre-/compact behavior).
    assert.equal(
      shouldShowTurnProgress({
        progressText: "Compacting context…",
        messages,
        sessionStatus: "completed",
        isLocallyStreaming: false,
      }),
      false,
    );
    assert.equal(
      shouldShowTurnProgress({
        progressText: "Compacting context…",
        messages,
        sessionStatus: "completed",
        isLocallyStreaming: false,
        overrideActive: true,
      }),
      true,
    );
    // Errors always win — no status row on failed sessions.
    assert.equal(
      shouldShowTurnProgress({
        progressText: "Compacting context…",
        messages,
        sessionStatus: "error",
        isLocallyStreaming: false,
        overrideActive: true,
      }),
      false,
    );
  });

  it("toolCardOwnsProgress suppresses the row — the card is the feedback", () => {
    const messages = [
      { role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ];
    const base = {
      messages,
      sessionStatus: "running" as const,
      isLocallyStreaming: false,
    };
    // Write/Patch running / args streaming / approval wait: card on screen.
    assert.equal(
      shouldShowTurnProgress({
        ...base,
        progressText: "Writing file…",
        toolCardOwnsProgress: true,
      }),
      false,
    );
    assert.equal(
      shouldShowTurnProgress({
        ...base,
        progressText: "Patching…",
        toolCardOwnsProgress: true,
      }),
      false,
    );
    // Model-phase lines are never attributed to a card tool.
    assert.equal(
      shouldShowTurnProgress({
        ...base,
        progressText: "Waiting for model…",
        toolCardOwnsProgress: false,
      }),
      true,
    );
  });
});
