import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";


const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

function escaped(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bodies(selector: string, sheet = css): string[] {
  const pattern = new RegExp(`(^|\\n)${escaped(selector)}\\s*\\{([\\s\\S]*?)\\}`, "g");
  return [...sheet.matchAll(pattern)].map((match) => match[2] ?? "");
}

function rule(selector: string, marker: RegExp, sheet = css): string {
  const found = bodies(selector, sheet).find((body) => marker.test(body));
  assert.ok(found, `missing ${selector} rule matching ${marker}`);
  return found;
}

test("chat collapse slides the pane out instead of squeezing its width", () => {
  const collapsed = rule(
    ".devmode-workbench.is-chat-collapsed .devmode-chat-pane",
    /margin-inline-end/,
  );
  assert.match(
    collapsed,
    /margin-inline-end:\s*calc\(-1 \* var\(--devmode-chat-width, 380px\)\)/,
  );
  assert.doesNotMatch(collapsed, /flex-basis/);
  assert.doesNotMatch(collapsed, /\bwidth:/);

  assert.match(rule(".devmode-chat-pane", /transition:/), /transition:\s*margin-inline-end 200ms/);
});

test("the sliding chat pane is clipped by the Dev Mode main slot", () => {
  assert.match(rule(".app-shell.is-dev-mode .app-shell-main", /overflow:/), /overflow:\s*clip/);
});

test("the splitter gives its gutter back with the pane", () => {
  assert.match(rule(".devmode-chat-split", /flex-basis 200ms/), /flex-basis 200ms/);
  assert.match(
    rule(".devmode-workbench.is-chat-collapsed .devmode-chat-split", /flex-basis/),
    /flex-basis:\s*0/,
  );
});

test("bottom panel collapses by clipping pinned views, not by hiding them", () => {
  assert.match(rule(".devmode-panel", /transition:/), /transition:\s*flex-basis 200ms/);
  assert.match(
    rule(".devmode-panel.is-collapsed", /flex-basis/),
    /flex-basis:\s*var\(--devmode-toolbar-height, 34px\)/,
  );

  const pinned = rule(".devmode-panel.is-collapsed > .devmode-panel-term", /calc\(/);
  assert.match(
    pinned,
    /flex:\s*0 0\s*\n?\s*calc\(var\(--devmode-panel-height, 232px\) - var\(--devmode-toolbar-height, 34px\)\)/,
  );

  assert.doesNotMatch(css, /\.devmode-panel\.is-collapsed[^{]*\.devmode-panel-view[^{]*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /\.devmode-panel\.is-collapsed[^{]*\.devmode-panel-term[^{]*\{[^}]*display:\s*none/);
});

test("the outline card collapses the same way", () => {
  assert.match(rule(".devmode-doc-outline", /transition:/), /transition:\s*flex-basis 200ms/);
  assert.match(
    rule(".devmode-doc-outline.is-collapsed", /flex-basis/),
    /flex-basis:\s*var\(--devmode-toolbar-height, 34px\)/,
  );
  assert.match(
    rule(".devmode-doc-outline.is-collapsed .devmode-doc-outline-body", /calc\(/),
    /flex:\s*0 0\s*\n?\s*calc\(var\(--devmode-doc-outline-height, 180px\) - var\(--devmode-toolbar-height, 34px\)\)/,
  );
  assert.doesNotMatch(
    css,
    /\.devmode-doc-outline\.is-collapsed \.devmode-doc-outline-body\s*\{[^}]*display:\s*none/,
  );
  assert.match(rule(".devmode-sidebar-stack", /transition:/), /transition:\s*gap 200ms/);
  assert.match(rule(".devmode-editor-pane", /transition:/), /transition:\s*gap 200ms/);
});

test("dragging a splitter keeps the 1:1 pointer tracking", () => {
  assert.match(
    css,
    /\.devmode-panel\.is-resizing,\s*\n\.devmode-doc-outline\.is-resizing \{[\s\S]*?transition: none/,
  );
});

test("reduced motion keeps the instant swap", () => {
  const blocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\n([\s\S]*?)\n\}/g);
  assert.ok(blocks);
  const motion = blocks.find((chunk) => chunk.includes(".devmode-chat-pane,"));
  assert.ok(motion, "missing reduced-motion block for the docking slides");
  for (const selector of [
    ".devmode-chat-pane,",
    ".devmode-panel,",
    ".devmode-doc-outline {",
  ]) {
    assert.ok(motion.includes(selector), `reduced-motion misses ${selector}`);
  }
  assert.match(motion, /transition:\s*none/);
});
