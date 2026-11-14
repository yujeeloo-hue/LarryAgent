/**
 * Agent-driven tab eviction pick (Dev Mode write_file / patch auto-open).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_OPEN_MAX_TABS,
  pickAgentEvictionVictim,
} from "./editorTabs.js";

describe("AGENT_OPEN_MAX_TABS", () => {
  it("caps agent auto-opens at 5 tabs", () => {
    assert.equal(AGENT_OPEN_MAX_TABS, 5);
  });
});

describe("pickAgentEvictionVictim", () => {
  it("returns the oldest opened clean non-active tab", () => {
    const tabs = [
      { path: "/a.ts", dirty: false },
      { path: "/b.ts", dirty: false },
      { path: "/c.ts", dirty: false },
    ];
    assert.equal(pickAgentEvictionVictim(tabs, "/c.ts"), "/a.ts");
  });

  it("skips dirty tabs — never silently discard user edits", () => {
    const tabs = [
      { path: "/a.ts", dirty: true },
      { path: "/b.ts", dirty: false },
    ];
    assert.equal(pickAgentEvictionVictim(tabs, null), "/b.ts");
  });

  it("skips the active tab even when it is the oldest", () => {
    const tabs = [
      { path: "/a.ts", dirty: false },
      { path: "/b.ts", dirty: false },
    ];
    assert.equal(pickAgentEvictionVictim(tabs, "/a.ts"), "/b.ts");
  });

  it("returns null when every candidate is dirty or active", () => {
    assert.equal(
      pickAgentEvictionVictim(
        [
          { path: "/a.ts", dirty: true },
          { path: "/b.ts", dirty: false },
        ],
        "/b.ts",
      ),
      null,
    );
    assert.equal(
      pickAgentEvictionVictim([{ path: "/a.ts", dirty: false }], "/a.ts"),
      null,
    );
    assert.equal(pickAgentEvictionVictim([], null), null);
  });
});
