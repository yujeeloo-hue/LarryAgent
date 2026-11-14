import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyToolsConfig,
  normalizeToolDisplayOverrides,
  parseToolsConfig,
} from "./types.js";

describe("normalizeToolDisplayOverrides", () => {
  it("returns {} for non-object payloads", () => {
    assert.deepEqual(normalizeToolDisplayOverrides(undefined), {});
    assert.deepEqual(normalizeToolDisplayOverrides(null), {});
    assert.deepEqual(normalizeToolDisplayOverrides("read_file"), {});
    assert.deepEqual(normalizeToolDisplayOverrides(42), {});
    assert.deepEqual(
      normalizeToolDisplayOverrides(["get_current_time", false]),
      {},
    );
  });

  it("keeps boolean values and trims keys", () => {
    assert.deepEqual(
      normalizeToolDisplayOverrides({ " get_current_time ": false }),
      { get_current_time: false },
    );
    assert.deepEqual(
      normalizeToolDisplayOverrides({ run_shell: true, read_file: false }),
      { run_shell: true, read_file: false },
    );
  });

  it("drops non-boolean values and empty keys", () => {
    assert.deepEqual(
      normalizeToolDisplayOverrides({
        run_shell: "false",
        edit_file: 0,
        "": true,
        "   ": false,
        read_file: null,
        write_file: false,
      }),
      { write_file: false },
    );
  });
});

describe("parseToolsConfig toolDisplayOverrides", () => {
  it("defaults to {} when absent", () => {
    const config = parseToolsConfig({});
    assert.deepEqual(config.toolDisplayOverrides, {});
    assert.deepEqual(emptyToolsConfig().toolDisplayOverrides, {});
  });

  it("parses alongside sibling override records", () => {
    const config = parseToolsConfig({
      toolPermissionOverrides: { run_shell: 2 },
      toolOfferOverrides: { read_file: true },
      toolDisplayOverrides: { get_current_time: false, "edit_file ": false },
      toolOfferAutoBaseline: ["search_tools"],
    });
    assert.deepEqual(config.toolPermissionOverrides, { run_shell: 2 });
    assert.deepEqual(config.toolOfferOverrides, { read_file: true });
    assert.deepEqual(config.toolDisplayOverrides, {
      get_current_time: false,
      edit_file: false,
    });
    assert.deepEqual(config.toolOfferAutoBaseline, ["search_tools"]);
  });

  it("resets invalid bodies to empty defaults", () => {
    const config = parseToolsConfig("nope");
    assert.deepEqual(config, emptyToolsConfig());
  });
});
