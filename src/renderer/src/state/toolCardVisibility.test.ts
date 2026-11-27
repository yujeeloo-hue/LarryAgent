import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  applyToolDisplayLocally,
  isToolCardHidden,
  listHiddenToolCardNames,
  refreshHiddenToolCards,
  setHiddenToolCardsForTests,
} from "./toolCardVisibility.js";

beforeEach(() => {
  setHiddenToolCardsForTests([]);
});

describe("toolCardVisibility renderer cache", () => {
  it("defaults to nothing hidden", () => {
    assert.equal(isToolCardHidden("run_shell"), false);
    assert.equal(isToolCardHidden("get_current_time"), false);
    assert.deepEqual(listHiddenToolCardNames(), []);
  });

  it("refreshHiddenToolCards replaces the set from the bridge", async () => {
    await refreshHiddenToolCards({
      getHiddenToolCards: async () => ["get_current_time", "run_shell"],
    });
    assert.equal(isToolCardHidden("get_current_time"), true);
    assert.equal(isToolCardHidden("run_shell"), true);
    assert.equal(isToolCardHidden("read_file"), false);
  });

  it("refresh with an empty list clears prior state", async () => {
    setHiddenToolCardsForTests(["run_shell"]);
    await refreshHiddenToolCards({ getHiddenToolCards: async () => [] });
    assert.equal(isToolCardHidden("run_shell"), false);
  });

  it("applyToolDisplayLocally adds a hidden name", () => {
    applyToolDisplayLocally("get_current_time", false);
    assert.equal(isToolCardHidden("get_current_time"), true);
    assert.deepEqual(listHiddenToolCardNames(), ["get_current_time"]);
  });

  it("applyToolDisplayLocally re-shows a hidden name", () => {
    setHiddenToolCardsForTests(["get_current_time", "run_shell"]);
    applyToolDisplayLocally("get_current_time", true);
    assert.equal(isToolCardHidden("get_current_time"), false);
    assert.equal(isToolCardHidden("run_shell"), true);
  });

  it("applyToolDisplayLocally trims and ignores empty names", () => {
    applyToolDisplayLocally("  get_current_time  ", false);
    assert.equal(isToolCardHidden("get_current_time"), true);
    applyToolDisplayLocally("", false);
    assert.deepEqual(listHiddenToolCardNames(), ["get_current_time"]);
  });

  it("toggle after refresh keeps other names intact (no clobber)", async () => {
    await refreshHiddenToolCards({
      getHiddenToolCards: async () => ["run_shell", "edit_file"],
    });
    applyToolDisplayLocally("run_shell", true);
    applyToolDisplayLocally("write_file", false);
    assert.equal(isToolCardHidden("run_shell"), false);
    assert.equal(isToolCardHidden("edit_file"), true);
    assert.equal(isToolCardHidden("write_file"), true);
  });
});
