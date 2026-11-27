import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const devmodeCss = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = devmodeCss.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

test("status carousel clips the 620ms glyph roll inside the status line", () => {
  const rolling = rule(".devmode-status-index.is-carousel-rolling");
  assert.match(rolling, /position:\s*relative/);
  assert.match(rolling, /clip-path:\s*inset\(0\)/);
  assert.match(rolling, /white-space:\s*pre/);
});

test("status carousel glyphs are absolutely positioned with a zero-width baseline anchor", () => {
  const glyph = rule(".devmode-status-index .status-carousel-glyph");
  assert.match(glyph, /position:\s*absolute/);
  assert.match(glyph, /top:\s*0/);
  assert.match(
    rule(".devmode-status-index .status-carousel-previous::before"),
    /content:\s*attr\(data-glyph\)/,
  );
  assert.match(
    rule(".devmode-status-index .status-carousel-anchor::before"),
    /content:\s*"\\200b"/,
  );
});
