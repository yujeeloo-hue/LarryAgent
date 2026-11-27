import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("./conversation.css", import.meta.url),
  "utf8",
);

function block(selector: RegExp): string {
  const match = css.match(selector);
  assert.ok(match?.[1], `missing rule ${selector}`);
  return match[1];
}

test("transcript edges fade through one mask that stops at the composer", () => {
  const mask = block(
    /\.conversation-messages:is\(\.is-fade-top, \.is-fade-bottom\)\s*\{([^}]*)\}/,
  );
  assert.match(mask, /mask-image:\s*linear-gradient\(/);
  assert.match(mask, /var\(--conversation-scroll-fade-top\)/);
  assert.match(mask, /calc\(100% - var\(--conversation-composer-clearance\)\)/);
  assert.match(mask, /transparent var\(--conversation-scroll-fade-bottom-end\)/);
  assert.doesNotMatch(mask, /background/);
});

test("each edge owns its stop variable", () => {
  const top = block(/\.conversation-messages\.is-fade-top\s*\{([^}]*)\}/);
  assert.match(top, /--conversation-scroll-fade-top:\s*var\(--conversation-scroll-fade-h\)/);

  const bottom = block(/\.conversation-messages\.is-fade-bottom\s*\{([^}]*)\}/);
  assert.match(bottom, /--conversation-scroll-fade-bottom-end:\s*calc\(/);
  assert.match(bottom, /100% - var\(--conversation-composer-clearance\) \+/);
  assert.match(bottom, /var\(--conversation-scroll-fade-bottom-h\)/);
});

test("the composer footer no longer paints a backdrop of its own", () => {
  const footer = block(/\.conversation-footer\s*\{([^}]*)\}/);
  assert.match(footer, /background:\s*none/);
  assert.doesNotMatch(footer, /linear-gradient/);
});

test("the compact CoCo composer inherits the same edge fades", () => {
  const compact = block(/\.conversation-compact-composer\s*\{([^}]*)\}/);
  assert.doesNotMatch(compact, /--conversation-scroll-fade/);
  assert.doesNotMatch(compact, /--conversation-composer-clearance/);
});

test("no leftover overlay fade element", () => {
  assert.doesNotMatch(css, /conversation-top-fade/);
});
