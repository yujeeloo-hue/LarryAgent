import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const css = readFileSync(
  fileURLToPath(new URL("./content-cards-demo.css", import.meta.url)),
  "utf8",
);

function ruleBlock(selector: string): string {
  const match = css.match(new RegExp(`\\.content-card-demo${selector}\\s*\\{[^}]*\\}`));
  assert.ok(match, `missing rule for .content-card-demo${selector}`);
  return match[0].replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("demo preview iframe background (corner fringe)", () => {
  it("declares a transparent background, never an opaque white backing", () => {
    const block = ruleBlock("-iframe");
    assert.match(block, /background:\s*transparent\b/);
    assert.doesNotMatch(block, /background[^;;]*\b(#fff|white)\b/i);
  });

  it("keeps the preview wrapper as the only rounding surface (radius + clip)", () => {
    const block = ruleBlock("-preview");
    assert.match(block, /border-radius:\s*8px/);
    assert.match(block, /overflow:\s*hidden/);
  });
});
