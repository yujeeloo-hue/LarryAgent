import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeToolPredicate,
  isToolNamePermitted,
  matchesToolNamePattern,
} from "./toolNameLists.js";

describe("toolNameLists", () => {
  it("matches exact and glob patterns", () => {
    assert.equal(matchesToolNamePattern("read_file", "read_file"), true);
    assert.equal(matchesToolNamePattern("write_file", "read_file"), false);
    assert.equal(matchesToolNamePattern("mcp__tavily__search", "mcp__tavily__*"), true);
    assert.equal(
      matchesToolNamePattern("mcp__jnote__List_notes", "mcp__jnote__list_*"),
      true,
    );
  });

  it("deny wins; empty lists allow all", () => {
    assert.equal(isToolNamePermitted("anything", {}), true);
    assert.equal(
      isToolNamePermitted("write_file", { denyTools: ["write_file"] }),
      false,
    );
    assert.equal(
      isToolNamePermitted("read_file", {
        allowTools: ["read_file"],
        denyTools: ["read_file"],
      }),
      false,
    );
  });

  it("composeToolPredicate intersects with base", () => {
    const pred = composeToolPredicate((n) => n !== "blocked", {
      allowTools: ["read_file", "blocked"],
    });
    assert.ok(pred);
    assert.equal(pred("read_file"), true);
    assert.equal(pred("blocked"), false);
    assert.equal(pred("write_file"), false);
  });
});
