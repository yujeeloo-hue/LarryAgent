import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enabledGraphEntries } from "./enabledGraphEntries.js";

describe("enabledGraphEntries", () => {
  it("keeps enabled graphs and drops disabled ones", () => {
    const entries = [
      { id: "a", name: "A", enabled: true, validation: { valid: true } },
      { id: "b", name: "B", enabled: false },
      { id: "c", name: "C", enabled: true, validation: { valid: true } },
    ];
    const result = enabledGraphEntries(entries);
    assert.deepEqual(
      result.map((e) => e.id),
      ["a", "c"],
    );
  });

  it("preserves order and handles empty input", () => {
    assert.deepEqual(enabledGraphEntries([]), []);
    const entries = [
      { id: "x", name: "X", enabled: false },
      { id: "y", name: "Y", enabled: false },
    ];
    assert.deepEqual(enabledGraphEntries(entries), []);
  });
});


it("rejects enabled but invalid, unverified or draft entries", () => {
  const entries = [
    { id: "good", enabled: true, validation: { valid: true } },
    { id: "invalid", enabled: true, validation: { valid: false } },
    { id: "unknown", enabled: true },
    { id: "draft", enabled: true, validation: { valid: true }, draftContextId: "draft-id" },
  ];
  assert.deepEqual(enabledGraphEntries(entries).map(entry => entry.id), ["good"]);
});
