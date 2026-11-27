import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const css = readFileSync(
  fileURLToPath(new URL("../src/style.css", import.meta.url)),
  "utf8",
);

function mediaBlockRanges(source: string, query: RegExp): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const opener = new RegExp(query.source, "g");
  for (;;) {
    const match = opener.exec(source);
    if (!match) return ranges;
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    ranges.push([match.index, index]);
  }
}

const mobileRanges = mediaBlockRanges(css, /@media\s*\(max-width:\s*768px\)[^{]*\{/);
const insideMobile = (index: number): boolean =>
  mobileRanges.some(([start, end]) => index >= start && index < end);

function ruleMatches(selector: string): Array<{ block: string; index: number }> {
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "g",
  );
  const found: Array<{ block: string; index: number }> = [];
  for (;;) {
    const match = pattern.exec(css);
    if (!match) return found;
    found.push({ block: match[1], index: match.index });
  }
}

describe("conversation header layout", () => {
  it("keeps the head at 44px on desktop instead of padding-driven growth", () => {
    const base = ruleMatches(".conv-head").filter((rule) => !insideMobile(rule.index));
    assert.equal(base.length, 1, "expected exactly one desktop .conv-head rule");
    assert.match(base[0].block, /min-height:\s*44px/);
    assert.match(base[0].block, /padding:\s*0 20px/);
  });

  it("hides the live progress block outside the mobile breakpoint", () => {
    const base = ruleMatches(".conv-head .conv-live").filter((rule) => !insideMobile(rule.index));
    assert.equal(base.length, 1, "expected a desktop-level rule hiding .conv-live");
    assert.match(base[0].block, /display:\s*none/);
  });

  it("still promotes the live progress block to a row stack on mobile", () => {
    const live = ruleMatches(".conv-head.is-live .conv-live");
    assert.ok(live.length > 0, "missing .conv-head.is-live .conv-live rule");
    assert.ok(live.every((rule) => insideMobile(rule.index)), "live stack must stay mobile-scoped");
    assert.match(live[0].block, /display:\s*flex/);
  });
});
