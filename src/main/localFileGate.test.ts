import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  gateLocalFilePath,
  isPathUnderRoot,
  LOCAL_FILE_PREVIEW_EXTS,
} from "./localFileGate.js";

let WS = "";

before(() => {
  WS = mkdtempSync(join(tmpdir(), "jb-filegate-"));
});

after(() => {
  rmSync(WS, { recursive: true, force: true });
});

describe("isPathUnderRoot", () => {
  it("accepts the root itself and nested paths", () => {
    assert.equal(isPathUnderRoot(WS, WS), true);
    assert.equal(
      isPathUnderRoot(join(WS, "demos", "a", "index.html"), WS),
      true,
    );
  });

  it("rejects sibling-prefix paths and outsiders", () => {
    assert.equal(isPathUnderRoot(join(`${WS}-evil`, "index.html"), WS), false);
    assert.equal(isPathUnderRoot("/etc/passwd", WS), false);
  });
});

describe("gateLocalFilePath", () => {
  it("missing path → 400", () => {
    const gate = gateLocalFilePath(null, []);
    assert.deepEqual(gate, {
      allowed: false,
      status: 400,
      reason: "Missing path",
    });
  });

  it("relative path → 404 (never resolved against main cwd)", () => {
    const gate = gateLocalFilePath("demo.html", [WS]);
    assert.equal(gate.allowed, false);
    if (!gate.allowed) assert.equal(gate.status, 404);
  });

  it("non-preview extension → 403", () => {
    const gate = gateLocalFilePath(join(WS, "app.exe"), []);
    assert.equal(gate.allowed, false);
    if (!gate.allowed) assert.equal(gate.status, 403);
  });

  it("images / pdf keep the extension-only gate", () => {
    assert.equal(gateLocalFilePath("/opt/anywhere/shot.png", []).allowed, true);
    assert.equal(gateLocalFilePath("/opt/anywhere/doc.pdf", []).allowed, true);
  });

  it("html under a demo root is allowed (.html and .htm)", () => {
    assert.equal(
      gateLocalFilePath(join(WS, "demos", "a", "index.html"), [WS]).allowed,
      true,
    );
    assert.equal(
      gateLocalFilePath(join(WS, "demos", "a", "old.htm"), [WS]).allowed,
      true,
    );
  });

  it("html under tmpdir is allowed when tmpdir is a root", () => {
    const gate = gateLocalFilePath(
      join(tmpdir(), "scratch", "demo.html"),
      [tmpdir()],
    );
    assert.equal(gate.allowed, true);
  });

  it("html outside every demo root → 403", () => {
    const gate = gateLocalFilePath("/Users/elsewhere/demo.html", [WS]);
    assert.equal(gate.allowed, false);
    if (!gate.allowed) assert.equal(gate.status, 403);
  });

  it("sibling-prefix directories do not pass as the root", () => {
    const gate = gateLocalFilePath(join(`${WS}-evil`, "demo.html"), [WS]);
    assert.equal(gate.allowed, false);
    if (!gate.allowed) assert.equal(gate.status, 403);
  });

  it("blank roots drop out of the check", () => {
    const gate = gateLocalFilePath(join(WS, "demo.html"), ["", "  "]);
    assert.equal(gate.allowed, false);
  });

  it("preview set covers images, pdf, and demo html", () => {
    assert.equal(LOCAL_FILE_PREVIEW_EXTS.has(".svg"), true);
    assert.equal(LOCAL_FILE_PREVIEW_EXTS.has(".html"), true);
    assert.equal(LOCAL_FILE_PREVIEW_EXTS.has(".htm"), true);
    assert.equal(LOCAL_FILE_PREVIEW_EXTS.has(".txt"), false);
  });
});
