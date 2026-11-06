import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROJECT_DOC_MAX_CHARS, PROJECT_MEMORY_MAX_CHARS } from "./types.js";
import { summarizeProjectTextIfNeeded } from "./summarize.js";

describe("summarizeProjectTextIfNeeded (no hard truncation)", () => {
  it("returns short bodies untouched", async () => {
    const out = await summarizeProjectTextIfNeeded({
      kind: "project",
      body: "short body",
      workspacePath: "/tmp/jb-test",
      client: null,
    });
    assert.equal(out.body, "short body");
    assert.equal(out.summarized, false);
    assert.equal(out.method, "none");
  });

  it("returns over-target project bodies unchanged without a client", async () => {
    const body = "z".repeat(PROJECT_MEMORY_MAX_CHARS + 2_000);
    const out = await summarizeProjectTextIfNeeded({
      kind: "project",
      body,
      workspacePath: "/tmp/jb-test",
      client: null,
    });
    assert.equal(out.body, body);
    assert.equal(out.summarized, false);
    assert.equal(out.method, "none");
  });

  it("uses the docs soft limit for log kinds", async () => {
    const body = "w".repeat(PROJECT_MEMORY_MAX_CHARS + 500);
    // Still under the docs limit → untouched even though over the project limit.
    assert.ok(body.length > PROJECT_MEMORY_MAX_CHARS);
    assert.ok(body.length < PROJECT_DOC_MAX_CHARS);
    const out = await summarizeProjectTextIfNeeded({
      kind: "worklog",
      body,
      workspacePath: "/tmp/jb-test",
      client: null,
    });
    assert.equal(out.body, body);
    assert.equal(out.summarized, false);
  });

  it("never truncates even under force without a client", async () => {
    const body = "z".repeat(100);
    const out = await summarizeProjectTextIfNeeded({
      kind: "pitfalls",
      body,
      workspacePath: "/tmp/jb-test",
      client: null,
      force: true,
    });
    assert.equal(out.body, body);
    assert.equal(out.summarized, false);
  });
});
