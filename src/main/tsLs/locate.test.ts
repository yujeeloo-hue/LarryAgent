import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { findTypeScriptServer, typescriptDocumentLanguage, typescriptServerCandidates } from "./locate.js";

test("a packaged app only ever uses the tsc shipped in its resources", () => {
  assert.deepEqual(
    typescriptServerCandidates({ packaged: true, resourcesPath: "/R", devRoots: ["/dev"] }, "darwin"),
    [join("/R", "typescript", "tsc")],
  );
  assert.deepEqual(
    typescriptServerCandidates({ packaged: true, resourcesPath: "C:/App/resources" }, "win32"),
    [join("C:/App/resources", "typescript", "tsc.exe")],
  );
  assert.deepEqual(typescriptServerCandidates({ packaged: true }, "win32"), []);
});

test("development uses the repository's extracted tsc for this platform", () => {
  assert.deepEqual(
    typescriptServerCandidates({ packaged: false, devRoots: ["/repo", "/repo"], arch: "arm64" }, "darwin"),
    [join("/repo", "resources", "typescript", "darwin-arm64", "tsc")],
  );
  assert.deepEqual(
    typescriptServerCandidates({ packaged: false, devRoots: ["/repo"], arch: "x64" }, "win32"),
    [join("/repo", "resources", "typescript", "win32-x64", "tsc.exe")],
  );
});

test("findTypeScriptServer returns the bundled binary or null, never a project or PATH fallback", () => {
  const bundled = join("/R", "typescript", "tsc");
  assert.equal(findTypeScriptServer({ packaged: true, resourcesPath: "/R" }, (p) => p === bundled, "darwin"), bundled);
  assert.equal(findTypeScriptServer({ packaged: true, resourcesPath: "/R" }, () => false, "darwin"), null);
});

test("every JS / TS extension gets the LSP language id the server expects", () => {
  assert.equal(typescriptDocumentLanguage("/a/b.ts"), "typescript");
  assert.equal(typescriptDocumentLanguage("/a/b.MTS"), "typescript");
  assert.equal(typescriptDocumentLanguage("/a/b.cts"), "typescript");
  assert.equal(typescriptDocumentLanguage("/a/b.tsx"), "typescriptreact");
  assert.equal(typescriptDocumentLanguage("C:\\a\\b.js"), "javascript");
  assert.equal(typescriptDocumentLanguage("/a/b.mjs"), "javascript");
  assert.equal(typescriptDocumentLanguage("/a/b.cjs"), "javascript");
  assert.equal(typescriptDocumentLanguage("/a/b.jsx"), "javascriptreact");
  assert.equal(typescriptDocumentLanguage("/a/b.d.ts"), "typescript");
  assert.equal(typescriptDocumentLanguage("/a/b.json"), null);
  assert.equal(typescriptDocumentLanguage("/a/Makefile"), null);
});
