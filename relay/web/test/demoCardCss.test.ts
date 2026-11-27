import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const css = readFileSync(
  fileURLToPath(new URL("../src/style.css", import.meta.url)),
  "utf8",
);

describe("demo preview iframe background (corner fringe)", () => {
  it("declares a transparent background, never an opaque white backing", () => {
    const match = css.match(/\.content-card-demo-iframe\s*\{[^}]*\}/);
    assert.ok(match, "missing .content-card-demo-iframe rule");
    const block = match[0].replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(block, /background:\s*transparent\b/);
    assert.doesNotMatch(block, /background[^;]*\b(#fff|white)\b/i);
  });
});
