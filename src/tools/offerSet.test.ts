import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  DEFAULT_OFFERED_TOOL_NAMES,
  MAX_USER_OFFERED_TOOLS,
  computeAutoOrganizeBaseline,
  resolveAlwaysOfferedToolNames,
} from "./offerSet.js";
import { clearToolOfferStateForTests } from "./offerConfig.js";

after(() => {
  clearToolOfferStateForTests();
});

describe("default tool offer set", () => {
  it("cap covers every default entry (no silent truncation)", () => {
    assert.ok(
      DEFAULT_OFFERED_TOOL_NAMES.length <= MAX_USER_OFFERED_TOOLS,
      `DEFAULT_OFFERED_TOOL_NAMES (${DEFAULT_OFFERED_TOOL_NAMES.length}) exceeds MAX_USER_OFFERED_TOOLS (${MAX_USER_OFFERED_TOOLS}); tail entries would be silently deferred`,
    );
  });

  it("symbols is offered eagerly on a fresh install (regression: 17th default was dropped at cap 16)", () => {
    clearToolOfferStateForTests();
    const offered = resolveAlwaysOfferedToolNames(DEFAULT_OFFERED_TOOL_NAMES);
    for (const name of DEFAULT_OFFERED_TOOL_NAMES) {
      assert.ok(offered.has(name), `${name} missing from default offers`);
    }
  });

  it("auto-organize with no stats falls back to defaults including symbols", () => {
    clearToolOfferStateForTests();
    const baseline = computeAutoOrganizeBaseline({
      registryNames: DEFAULT_OFFERED_TOOL_NAMES,
      callCounts: [],
    });
    assert.ok(baseline.includes("symbols"));
  });
});