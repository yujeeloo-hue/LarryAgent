import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enabledGraphEntries } from "./enabledGraphEntries.js";

describe("enabledGraphEntries", () => {
  it("keeps enabled graphs and drops disabled ones", () => {
    const entries = [
      { id: "a", name: "A", enabled: true },
      { id: "b", name: "B", enabled: false },
      { id: "c", name: "C", enabled: true },
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
