import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyComposerRunModeLocal,
  cycleComposerRunMode,
  getComposerRunMode,
  initComposerRunMode,
  isPlanModeEnabled,
  type ComposerRunMode,
} from "./planModeState.js";

// planModeState persists through `window.jellybot`; in node tests the bridge
// is absent, which is fine — persistence is best-effort optional chaining.
declare global {
  // eslint-disable-next-line no-var
  var window: { jellybot?: unknown } | undefined;
}
(globalThis as { window?: { jellybot?: unknown } }).window = {};

describe("composer run mode cycle", () => {
  it("cycles agent → ask → plan → agent", () => {
    initComposerRunMode("agent");
    assert.equal(cycleComposerRunMode(), "ask");
    assert.equal(cycleComposerRunMode(), "plan");
    assert.equal(cycleComposerRunMode(), "agent");
  });

  it("isPlanModeEnabled only for plan", () => {
    initComposerRunMode("agent");
    assert.equal(isPlanModeEnabled(), false);
    initComposerRunMode("ask");
    assert.equal(isPlanModeEnabled(), false);
    initComposerRunMode("plan");
    assert.equal(isPlanModeEnabled(), true);
  });

  it("init ignores invalid values including legacy infinite", () => {
    initComposerRunMode("plan");
    initComposerRunMode("infinite" as ComposerRunMode);
    assert.equal(getComposerRunMode(), "plan");
    initComposerRunMode("junk" as ComposerRunMode);
    assert.equal(getComposerRunMode(), "plan");
  });

  it("applyComposerRunModeLocal accepts ask and ignores junk", () => {
    initComposerRunMode("agent");
    applyComposerRunModeLocal("ask" as ComposerRunMode);
    assert.equal(getComposerRunMode(), "ask");
    applyComposerRunModeLocal("infinite" as ComposerRunMode);
    assert.equal(getComposerRunMode(), "ask");
    applyComposerRunModeLocal("junk" as ComposerRunMode);
    assert.equal(getComposerRunMode(), "ask");
  });
});
