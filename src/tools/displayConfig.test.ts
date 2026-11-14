import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  ALWAYS_VISIBLE_TOOLS,
  clearToolDisplayOverride,
  clearToolDisplayStateForTests,
  getAllToolDisplayOverrides,
  getToolDisplayOverride,
  isToolCardVisible,
  listHiddenToolCards,
  loadToolDisplayOverrides,
  setToolDisplayOverride,
} from "./displayConfig.js";

beforeEach(() => {
  clearToolDisplayStateForTests();
});

describe("displayConfig memory state", () => {
  it("defaults every tool to visible", () => {
    assert.equal(isToolCardVisible("run_shell"), true);
    assert.equal(isToolCardVisible("get_current_time"), true);
    assert.equal(getToolDisplayOverride("run_shell"), undefined);
    assert.deepEqual(listHiddenToolCards(), []);
    assert.deepEqual(getAllToolDisplayOverrides(), {});
  });

  it("hides on false and restores on clear (sparse key removal)", () => {
    setToolDisplayOverride("get_current_time", false);
    assert.equal(isToolCardVisible("get_current_time"), false);
    assert.equal(getToolDisplayOverride("get_current_time"), false);
    assert.deepEqual(listHiddenToolCards(), ["get_current_time"]);
    assert.deepEqual(getAllToolDisplayOverrides(), {
      get_current_time: false,
    });

    clearToolDisplayOverride("get_current_time");
    assert.equal(isToolCardVisible("get_current_time"), true);
    assert.deepEqual(listHiddenToolCards(), []);
    assert.deepEqual(getAllToolDisplayOverrides(), {});
  });

  it("stores only explicit false as hidden in getAll snapshot", () => {
    setToolDisplayOverride("run_shell", false);
    setToolDisplayOverride("read_file", true);
    // getAll keeps both (persist writes the whole record); hidden list is
    // the false-only projection consumed by the renderer.
    assert.deepEqual(getAllToolDisplayOverrides(), {
      run_shell: false,
      read_file: true,
    });
    assert.deepEqual(listHiddenToolCards(), ["run_shell"]);
  });

  it("trims names and ignores empty ones", () => {
    setToolDisplayOverride("  run_shell  ", false);
    assert.equal(isToolCardVisible("run_shell"), false);
    setToolDisplayOverride("", false);
    setToolDisplayOverride("   ", false);
    assert.deepEqual(listHiddenToolCards(), ["run_shell"]);
  });
});

describe("displayConfig always-visible tools", () => {
  it("locks interactive panels and plan progress cards", () => {
    assert.ok(ALWAYS_VISIBLE_TOOLS.has("ask_user"));
    assert.ok(ALWAYS_VISIBLE_TOOLS.has("request_full_permissions"));
    assert.ok(ALWAYS_VISIBLE_TOOLS.has("create_plan"));
    assert.ok(ALWAYS_VISIBLE_TOOLS.has("update_plan"));
    assert.ok(ALWAYS_VISIBLE_TOOLS.has("complete_plan"));
  });

  it("ignores hide attempts on locked tools", () => {
    setToolDisplayOverride("ask_user", false);
    setToolDisplayOverride("create_plan", false);
    assert.equal(isToolCardVisible("ask_user"), true);
    assert.equal(isToolCardVisible("create_plan"), true);
    assert.deepEqual(listHiddenToolCards(), []);
    assert.deepEqual(getAllToolDisplayOverrides(), {});
  });
});

describe("loadToolDisplayOverrides", () => {
  it("replaces prior state with the persisted record", () => {
    setToolDisplayOverride("run_shell", false);
    loadToolDisplayOverrides({ get_current_time: false });
    assert.equal(isToolCardVisible("run_shell"), true);
    assert.equal(isToolCardVisible("get_current_time"), false);
  });

  it("drops non-boolean values, trims keys, skips locked names", () => {
    // Malformed payload on purpose — load must stay defensive at runtime.
    loadToolDisplayOverrides({
      " read_file ": false,
      run_shell: "false",
      edit_file: 0,
      "": false,
      ask_user: false,
      complete_plan: false,
      write_file: true,
    } as unknown as Record<string, boolean>);
    assert.equal(isToolCardVisible("read_file"), false);
    assert.equal(isToolCardVisible("run_shell"), true);
    assert.equal(isToolCardVisible("edit_file"), true);
    assert.equal(isToolCardVisible("ask_user"), true);
    assert.equal(isToolCardVisible("complete_plan"), true);
    assert.deepEqual(listHiddenToolCards(), ["read_file"]);
  });

  it("accepts null / undefined payloads as a reset to defaults", () => {
    setToolDisplayOverride("run_shell", false);
    loadToolDisplayOverrides(null);
    assert.equal(isToolCardVisible("run_shell"), true);
    setToolDisplayOverride("run_shell", false);
    loadToolDisplayOverrides(undefined);
    assert.equal(isToolCardVisible("run_shell"), true);
  });
});
