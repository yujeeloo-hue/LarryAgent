import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { resolveToolPath } from "./pathUtil.js";

// Resolved so both POSIX and Windows treat these as absolute local paths.
const WORKSPACE = resolve("/tmp/jb-workspace");

describe("resolveToolPath file:// normalization", () => {
  it("accepts a file:// URL and resolves it to the filesystem path", () => {
    const target = resolve("/tmp/jb-workspace/a/b.png");
    const url = pathToFileURL(target).href;
    const out = resolveToolPath(url, {
      workspacePath: WORKSPACE,
      allowOutsideWorkspace: false,
    });
    assert.ok(out.ok);
    assert.equal(out.path.absolute, target);
    assert.equal(out.path.outsideWorkspace, false);
  });

  it("flags a file:// URL outside the workspace like a plain path", () => {
    const url = pathToFileURL(resolve("/tmp/elsewhere/c.png")).href;
    const out = resolveToolPath(url, {
      workspacePath: WORKSPACE,
      allowOutsideWorkspace: false,
    });
    assert.ok(!out.ok);
    assert.match(out.reason, /outside the workspace/i);
  });

  it("rejects an invalid file: URL with the absolute-path error", () => {
    const out = resolveToolPath("file://not a valid url", {
      workspacePath: WORKSPACE,
      allowOutsideWorkspace: false,
    });
    assert.ok(!out.ok);
    assert.match(out.reason, /absolute path/i);
  });
});
