import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** CSS gate for the sidebar split (Dev Mode file tree card ↔ Outline card).
 *
 * Regressions this file pins:
 * 1. The sidebar must stay a bare gutter column — the two cards draw their
 *    own chrome; going back to one card around the whole sidebar means the
 *    outline header's divider and the card border collapse into one edge.
 * 2. The outline resize handle lives in the gutter: its negative margins
 *    swallow the stack gap, so the cards keep exactly one pane gap apart
 *    whether the handle is shown or hidden.
 * 3. Its highlight speaks the splitter vocabulary (2px rounded
 *    `--pane-divider-hover` pill faded via opacity), not a 1px accent
 *    hairline.
 */
const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");
const shellCss = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");

function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Line-anchored so prefixed variants never match.
  const match = sheet.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

test("sidebar host is a transparent gutter column, not a card", () => {
  const host = rule(shellCss, ".app-shell.is-dev-mode .app-shell-sidebar");
  assert.match(host, /border:\s*0/);
  assert.match(host, /background:\s*transparent/);
  assert.doesNotMatch(host, /border-radius:\s*var\(--devmode-pane-radius/);
  assert.doesNotMatch(host, /background:\s*var\(--bg-main\)/);
});

test("the stack spaces the two cards with one pane gap", () => {
  const stack = rule(css, ".devmode-sidebar-stack");
  assert.match(stack, /flex-direction:\s*column/);
  assert.match(stack, /gap:\s*var\(--devmode-pane-gap, 8px\)/);
});

test("file tree card and outline card share the pane chrome", () => {
  const cards = css.match(
    /\.devmode-files-card,\s*\n\.devmode-doc-outline\s*\{([\s\S]*?)\}/,
  );
  assert.ok(cards, "missing shared sidebar card rule");
  assert.match(cards[1], /border:\s*1px solid var\(--devmode-pane-border/);
  assert.match(cards[1], /border-radius:\s*var\(--devmode-pane-radius, 10px\)/);
  assert.match(cards[1], /background:\s*var\(--bg-main\)/);
  assert.match(cards[1], /overflow:\s*hidden/);

  // The tree card is the flexible half; the outline keeps its stored height.
  assert.match(rule(css, ".devmode-files-card"), /flex:\s*1 1 auto/);
  // `rule()` is line-anchored, so the shared selector's second line would
  // match it — read the outline's own block from the head of the rule body.
  assert.match(
    css,
    /\.devmode-doc-outline\s*\{\s*\n\s*flex:\s*0 0 var\(--devmode-doc-outline-height, 180px\)/,
  );
  // No leftover inner divider doubling the card edge.
  assert.doesNotMatch(css, /\.is-collapsed \.devmode-doc-outline-head\s*\{[^}]*border-top/);
});

test("outline resize handle fills the gutter instead of adding height", () => {
  const handle = rule(css, ".devmode-doc-outline-resize");
  assert.match(handle, /flex:\s*0 0 var\(--devmode-pane-gap, 8px\)/);
  assert.match(handle, /height:\s*var\(--devmode-pane-gap, 8px\)/);
  // Negative margins: 8px gap + 8px handle − 2×8px = one pane gap of air.
  assert.match(handle, /margin:\s*calc\(-1 \* var\(--devmode-pane-gap, 8px\)\) 0/);
  // Resting state draws nothing — the gap itself is the separator.
  assert.match(handle, /background:\s*transparent/);
  assert.doesNotMatch(handle, /background:\s*var\(--divider\)/);
});

test("resize highlight matches the workbench splitter vocabulary", () => {
  const pill = rule(css, ".devmode-doc-outline-resize::before");
  assert.match(pill, /height:\s*2px/);
  assert.match(pill, /border-radius:\s*2px/);
  assert.match(pill, /left:\s*var\(--devmode-pane-radius, 10px\)/);
  assert.match(pill, /right:\s*var\(--devmode-pane-radius, 10px\)/);
  assert.match(pill, /background:\s*var\(--pane-divider-hover\)/);
  assert.match(pill, /opacity:\s*0/);
  assert.match(pill, /transition:\s*opacity 120ms ease/);
  // No centered fixed-width short bar.
  assert.doesNotMatch(pill, /width:\s*\d+px/);

  const hover = rule(
    css,
    ".devmode-doc-outline-resize:is(:hover, :focus-visible, .is-dragging)::before",
  );
  assert.match(hover, /opacity:\s*1/);
  assert.doesNotMatch(hover, /background:/);
});

test("drag keeps the highlight 1:1 with the pointer", () => {
  assert.match(
    rule(css, ".devmode-doc-outline-resize.is-dragging::before"),
    /transition:\s*none/,
  );
});

test("collapsed outline draws one edge, not two", () => {
  // Collapsed, the head is the whole card — its header hairline would stack
  // on the card's own bottom border into a 2px double edge.
  const head = rule(css, ".devmode-doc-outline.is-collapsed .devmode-doc-outline-head");
  assert.match(head, /border-bottom:\s*0/);
});
