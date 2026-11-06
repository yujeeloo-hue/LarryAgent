import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { registerBuiltins } from "./index.js";
import {
  listToolCatalog,
  setToolCatalogDisplay,
} from "./catalogService.js";
import {
  clearToolDisplayStateForTests,
  getAllToolDisplayOverrides,
} from "./displayConfig.js";

before(() => {
  registerBuiltins();
});

beforeEach(() => {
  clearToolDisplayStateForTests();
});

function findEntry(name: string) {
  const entry = listToolCatalog().find((t) => t.name === name);
  assert.ok(entry, `catalog entry missing: ${name}`);
  return entry;
}

describe("catalog display visibility", () => {
  it("defaults every entry to visible", () => {
    const entry = findEntry("get_current_time");
    assert.equal(entry.visible, true);
    assert.equal(entry.displayLocked, undefined);
  });

  it("locks always-visible tools with displayLocked", () => {
    for (const name of [
      "ask_user",
      "request_full_permissions",
      "create_plan",
      "update_plan",
      "complete_plan",
    ]) {
      const entry = findEntry(name);
      assert.equal(entry.visible, true, name);
      assert.equal(entry.displayLocked, true, name);
    }
  });

  it("setToolCatalogDisplay(false) hides, (true) restores sparse", () => {
    const hidden = setToolCatalogDisplay("get_current_time", false);
    assert.equal(hidden.visible, false);
    assert.equal(hidden.displayLocked, undefined);
    assert.deepEqual(getAllToolDisplayOverrides(), {
      get_current_time: false,
    });
    assert.equal(findEntry("get_current_time").visible, false);

    const shown = setToolCatalogDisplay("get_current_time", true);
    assert.equal(shown.visible, true);
    assert.deepEqual(getAllToolDisplayOverrides(), {});
    assert.equal(findEntry("get_current_time").visible, true);
  });

  it("setToolCatalogDisplay ignores locked tools (no override stored)", () => {
    for (const name of ["ask_user", "create_plan", "complete_plan"]) {
      const updated = setToolCatalogDisplay(name, false);
      assert.equal(updated.visible, true, name);
      assert.equal(updated.displayLocked, true, name);
    }
    assert.deepEqual(getAllToolDisplayOverrides(), {});
  });

  it("setToolCatalogDisplay throws for unknown tools", () => {
    assert.throws(() => setToolCatalogDisplay("no_such_tool", false), /Unknown tool/);
  });
});
