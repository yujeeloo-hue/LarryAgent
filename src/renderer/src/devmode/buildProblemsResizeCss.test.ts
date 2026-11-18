import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

test("the splitter is a gutter handle, not a pane border", () => {
  assert.doesNotMatch(
    rule(".devmode-build-problems"),
    /border-(right|bottom):/,
    "problems pane must not draw its own edge",
  );
  const handle = rule(".devmode-build-problems-resize");
  assert.match(handle, /flex:\s*0 0 var\(--devmode-pane-gap, 8px\)/);
  assert.match(handle, /width:\s*var\(--devmode-pane-gap, 8px\)/);
  assert.match(handle, /align-self:\s*stretch/);
  assert.match(handle, /cursor:\s*col-resize/);
  assert.match(handle, /touch-action:\s*none/);
  assert.match(handle, /background:\s*transparent/);
});

test("pane size is driven by one CSS variable", () => {
  const pane = rule(".devmode-build-problems");
  assert.match(pane, /flex:\s*0 0 var\(--devmode-build-problems-size, 252px\)/);
  assert.match(pane, /width:\s*var\(--devmode-build-problems-size, 252px\)/);
});

test("resting hairline, splitter pill on hover", () => {
  const rest = rule(".devmode-build-problems-resize::before");
  assert.match(rest, /width:\s*1px/);
  assert.match(rest, /background:\s*var\(--border\)/);
  assert.match(rest, /left:\s*0;/);
  assert.doesNotMatch(rest, /calc\(50%/);

  const hover = rule(
    ".devmode-build-problems-resize:is(:hover, :focus-visible, .is-dragging)::before",
  );
  assert.match(hover, /width:\s*2px/);
  assert.match(hover, /border-radius:\s*2px/);
  assert.match(hover, /background:\s*var\(--pane-divider-hover\)/);
  assert.doesNotMatch(hover, /left:/);
});

test("drag keeps the highlight 1:1 with the pointer", () => {
  assert.match(
    rule(".devmode-build-problems-resize.is-dragging::before"),
    /transition:\s*none/,
  );
});

test("stacked panel turns the same gutter horizontal", () => {
  const stacked = css.slice(css.indexOf("@container devmode-panel (max-width: 650px)"));
  assert.match(stacked, /\.devmode-build-problems-resize\s*\{[^}]*cursor:\s*row-resize/);
  assert.match(
    stacked,
    /\.devmode-build-problems-resize\s*\{[^}]*height:\s*var\(--devmode-pane-gap, 8px\)/,
  );
  assert.match(stacked, /\.devmode-build-problems-resize::before\s*\{[^}]*height:\s*1px/);
  assert.match(stacked, /\.devmode-build-problems-resize::before\s*\{[^}]*top:\s*0;/);
  assert.doesNotMatch(stacked, /devmode-build-problems-resize[^}]*calc\(50%/);
});
