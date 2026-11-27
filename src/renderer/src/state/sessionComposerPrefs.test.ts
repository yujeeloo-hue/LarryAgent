import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPOSER_DRAFT_KEY,
  getComposerPrefs,
  hydrateComposerPrefs,
  resetComposerPrefsForTest,
  seedComposerPrefsDefaults,
  setComposerPrefsFor,
  subscribeComposerPrefs,
} from "./sessionComposerPrefs.js";

declare global {
  // eslint-disable-next-line no-var
  var window: { jellybot?: unknown } | undefined;
}
(globalThis as { window?: { jellybot?: unknown } }).window = {};

describe("sessionComposerPrefs keyed store", () => {
  it("resolves unpinned keys from seeded defaults", () => {
    resetComposerPrefsForTest();
    seedComposerPrefsDefaults({
      runMode: "plan",
      infinite: true,
      reasoningEffort: "medium",
    });
    assert.deepEqual(getComposerPrefs("session-a"), {
      runMode: "plan",
      infinite: true,
      reasoningEffort: "medium",
      fsmGraphId: null,
    });
  });

  it("changes on one session key do not leak to others or the draft", () => {
    resetComposerPrefsForTest();
    setComposerPrefsFor("session-a", { runMode: "ask", infinite: true });
    assert.equal(getComposerPrefs("session-a").runMode, "ask");
    assert.equal(getComposerPrefs("session-b").runMode, "agent");
    assert.equal(getComposerPrefs(COMPOSER_DRAFT_KEY).runMode, "agent");
    assert.equal(getComposerPrefs(COMPOSER_DRAFT_KEY).infinite, false);
  });

  it("partial patches merge over previously pinned fields", () => {
    resetComposerPrefsForTest();
    setComposerPrefsFor("session-a", { runMode: "ask", infinite: true });
    setComposerPrefsFor("session-a", { runMode: "plan" });
    assert.deepEqual(getComposerPrefs("session-a"), {
      runMode: "plan",
      infinite: true,
      reasoningEffort: "low",
      fsmGraphId: null,
    });
  });

  it("hydrate maps a session row and treats NULL as unpinned", () => {
    resetComposerPrefsForTest();
    seedComposerPrefsDefaults({ runMode: "ask", infinite: true });
    hydrateComposerPrefs("session-a", {
      runMode: null,
      infinite: false,
      reasoningEffort: null,
    });
    assert.equal(getComposerPrefs("session-a").runMode, "ask");
    assert.equal(getComposerPrefs("session-a").infinite, false);
    assert.equal(getComposerPrefs("session-a").reasoningEffort, "low");
    hydrateComposerPrefs("session-b", {});
    assert.equal(getComposerPrefs("session-b").runMode, "ask");
    assert.equal(getComposerPrefs("session-b").infinite, true);
  });

  it("draft changes seed the process-wide defaults (New Task semantics)", () => {
    resetComposerPrefsForTest();
    setComposerPrefsFor(COMPOSER_DRAFT_KEY, {
      infinite: true,
      reasoningEffort: "max",
    });
    assert.equal(getComposerPrefs(COMPOSER_DRAFT_KEY).infinite, true);
    assert.equal(getComposerPrefs(COMPOSER_DRAFT_KEY).reasoningEffort, "max");
    assert.equal(getComposerPrefs("session-unpinned").infinite, true);
    assert.equal(getComposerPrefs("session-unpinned").reasoningEffort, "max");
  });

  it("subscribe fires only for its own key", () => {
    resetComposerPrefsForTest();
    const hitsA: number[] = [];
    const hitsDraft: number[] = [];
    subscribeComposerPrefs("session-a", () => hitsA.push(1));
    subscribeComposerPrefs(COMPOSER_DRAFT_KEY, () => hitsDraft.push(1));

    setComposerPrefsFor("session-a", { runMode: "plan" });
    assert.equal(hitsA.length, 1);
    assert.equal(hitsDraft.length, 0);

    setComposerPrefsFor(COMPOSER_DRAFT_KEY, { infinite: true });
    assert.equal(hitsA.length, 1);
    assert.equal(hitsDraft.length, 1);

    hydrateComposerPrefs("session-a", { runMode: "ask" });
    assert.equal(hitsA.length, 2);
    assert.equal(hitsDraft.length, 1);
  });

  it("unsubscribe stops delivery", () => {
    resetComposerPrefsForTest();
    let hits = 0;
    const off = subscribeComposerPrefs("session-a", () => hits++);
    setComposerPrefsFor("session-a", { runMode: "plan" });
    off();
    setComposerPrefsFor("session-a", { runMode: "ask" });
    assert.equal(hits, 1);
  });
});
