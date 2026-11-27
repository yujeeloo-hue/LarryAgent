import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { configureCheckoutRoots, resolveToolPath } from "./pathUtil.js";

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

describe("resolveToolPath collaborative checkout roots", () => {
  it("treats materialized checkout files as in-workspace and hints at materialize for missing ones", async () => {
    const parent = join(process.cwd(), "tmp", "path-util-tests");
    await mkdir(parent, { recursive: true });
    const temp = await mkdtemp(join(parent, "roots-"));
    const workspace = join(temp, "main");
    const checkout = join(temp, "shadow");
    await mkdir(workspace);
    await mkdir(join(checkout, "Source"), { recursive: true });
    await writeFile(join(checkout, "Source", "a.ts"), "a\n");
    configureCheckoutRoots((path) => (path === workspace ? [checkout] : []));
    try {
      const present = resolveToolPath(join(checkout, "Source", "a.ts"), { workspacePath: workspace, allowOutsideWorkspace: false });
      assert.ok(present.ok);
      assert.equal(present.path.outsideWorkspace, false);
      const absent = resolveToolPath(join(checkout, "Source", "b.ts"), { workspacePath: workspace, allowOutsideWorkspace: true });
      assert.ok(!absent.ok);
      assert.match(absent.reason, /op=materialize/);
      const otherWorkspace = resolveToolPath(join(checkout, "Source", "a.ts"), { workspacePath: join(temp, "other"), allowOutsideWorkspace: false });
      assert.ok(!otherWorkspace.ok);
      assert.match(otherWorkspace.reason, /outside the workspace/);
    } finally {
      configureCheckoutRoots(() => []);
    }
  });
});
