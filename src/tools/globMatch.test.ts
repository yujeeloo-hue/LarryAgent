import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileGlob } from "./globMatch.js";

const cs = { caseInsensitive: false };

describe("compileGlob", () => {
  it("matches slash-free patterns at any depth", () => {
    const m = compileGlob("*.ts", cs);
    assert.equal(m("a.ts"), true);
    assert.equal(m("src/tools/grep.ts"), true);
    assert.equal(m("src/tools/grep.tsx"), false);
  });

  it("anchors patterns that contain a slash", () => {
    const m = compileGlob("src/*.ts", cs);
    assert.equal(m("src/a.ts"), true);
    assert.equal(m("src/x/a.ts"), false);
    assert.equal(m("lib/src/a.ts"), false);
  });

  it("supports ** across directories, including zero segments", () => {
    const m = compileGlob("src/**/*.ts", cs);
    assert.equal(m("src/a.ts"), true);
    assert.equal(m("src/x/y/a.ts"), true);
    assert.equal(m("lib/a.ts"), false);
  });

  it("supports braces, ? and character classes", () => {
    const m = compileGlob("**/grep*.{ts,tsx}", cs);
    assert.equal(m("src/grep.test.ts"), true);
    assert.equal(m("grepView.tsx"), true);
    assert.equal(m("src/grep.js"), false);
    assert.equal(compileGlob("a?.md", cs)("ab.md"), true);
    assert.equal(compileGlob("[!b]*.md", cs)("a.md"), true);
    assert.equal(compileGlob("[!b]*.md", cs)("b.md"), false);
  });

  it("treats a trailing slash as everything below that directory", () => {
    const m = compileGlob("docs/", cs);
    assert.equal(m("docs/a.md"), true);
    assert.equal(m("docs/x/b.md"), true);
    assert.equal(m("src/docs.md"), false);
  });

  it("escapes regex metacharacters and honours case folding", () => {
    assert.equal(compileGlob("a+b(1).txt", cs)("a+b(1).txt"), true);
    assert.equal(compileGlob("README.md", cs)("readme.md"), false);
    assert.equal(compileGlob("README.md", { caseInsensitive: true })("readme.md"), true);
  });
});
