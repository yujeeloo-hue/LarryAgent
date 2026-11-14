import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** CSS gate for "collapsed merges, expanded detaches" on both columns.
 *
 * Regressions this file pins:
 * 1. Collapsed, the bottom panel strip is the last row *of the editor card* —
 *    one border, one radius, zero gutter. Docking must not add air there.
 * 2. Expanded, the editor pane turns into a bare gutter column and both
 *    halves draw their own card chrome exactly one `--devmode-pane-gap` apart.
 * 3. The panel root must stay unclipped (`overflow` untouched), or the More
 *    menu can no longer open above the detached card.
 * 4. The sidebar outline follows the same rule: collapsed it shares the file
 *    tree card (no gap, no second edge), expanded it is its own card.
 */
const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

const DOCKED = ".devmode-editor-pane:has(> .devmode-panel:not(.is-collapsed))";

test("editor card keeps its chrome while the panel is collapsed", () => {
  // No `:has` variant may strip the pane's own card look in the resting state;
  // the only rules that do are scoped to the expanded panel.
  const pane = rule(".devmode-editor-pane");
  assert.match(pane, /flex-direction:\s*column/);
  assert.doesNotMatch(pane, /gap:/);
  // The shared card rule still applies to the pane.
  assert.match(
    css,
    /\.devmode-editor-pane,\s*\n\.devmode-chat-pane\s*\{[^}]*border:\s*1px solid var\(--devmode-pane-border/,
  );
});

test("expanded, the pane becomes a bare gutter column", () => {
  const docked = rule(DOCKED);
  assert.match(docked, /border:\s*0/);
  assert.match(docked, /border-radius:\s*0/);
  assert.match(docked, /background:\s*transparent/);
  assert.match(docked, /gap:\s*var\(--devmode-pane-gap, 8px\)/);
});

test("expanded, both halves draw the pane card chrome", () => {
  const cards = rule(`${DOCKED} > .devmode-editor-root,\n${DOCKED} > .devmode-panel`);
  assert.match(cards, /border:\s*1px solid var\(--devmode-pane-border/);
  assert.match(cards, /border-radius:\s*var\(--devmode-pane-radius, 10px\)/);
  assert.match(cards, /background:\s*var\(--bg-main\)/);
  // Editor content must be clipped to the card's rounded corners.
  assert.match(rule(`${DOCKED} > .devmode-editor-root`), /overflow:\s*hidden/);
});

test("detached strip drops the edge the card now owns", () => {
  const strip = rule(`${DOCKED} > .devmode-panel > .devmode-panel-tabs`);
  assert.match(strip, /border-top:\s*0/);
  assert.match(strip, /border-radius:\s*calc\(var\(--devmode-pane-radius, 10px\) - 1px\)/);
  // Collapsed, that hairline is the seam between editor content and the strip.
  assert.doesNotMatch(
    css,
    /\.devmode-panel\.is-collapsed \.devmode-panel-tabs\s*\{[^}]*border-top:\s*0/,
  );
});

test("panel root stays unclipped so the More menu can escape", () => {
  const panel = rule(".devmode-panel");
  assert.doesNotMatch(panel, /overflow:\s*hidden/);
  // Bottom corners are clipped by the inner surfaces instead.
  const inner = rule(
    `${DOCKED} > .devmode-panel > .devmode-panel-term,\n${DOCKED} > .devmode-panel > .devmode-panel-view`,
  );
  assert.match(inner, /border-radius:\s*0 0 calc\(var\(--devmode-pane-radius, 10px\) - 1px\)/);
});

test("detached resize handle lives in the gutter", () => {
  const handle = rule(`${DOCKED} > .devmode-panel > .devmode-panel-resize`);
  assert.match(handle, /top:\s*calc\(-1 \* var\(--devmode-pane-gap, 8px\)\)/);
  assert.match(handle, /height:\s*var\(--devmode-pane-gap, 8px\)/);
  // Same splitter pill as the sidebar, not an accent hairline.
  const pill = rule(`${DOCKED} > .devmode-panel > .devmode-panel-resize::before`);
  assert.match(pill, /background:\s*var\(--pane-divider-hover\)/);
  assert.match(pill, /opacity:\s*0/);
  assert.match(rule(`${DOCKED} > .devmode-panel > .devmode-panel-resize:is(:hover, :focus-visible, .is-dragging)`), /background:\s*transparent/);
});

test("collapsed outline merges into the file tree card", () => {
  const stack = rule(".devmode-sidebar-stack:has(> .devmode-doc-outline.is-collapsed)");
  assert.match(stack, /gap:\s*0/);

  const tree = rule(
    ".devmode-sidebar-stack:has(> .devmode-doc-outline.is-collapsed) > .devmode-files-card",
  );
  assert.match(tree, /border-bottom-left-radius:\s*0/);
  assert.match(tree, /border-bottom-right-radius:\s*0/);
  // The tree card keeps its bottom border as the single seam.
  assert.doesNotMatch(tree, /border-bottom:\s*0/);

  const outline = rule(
    ".devmode-sidebar-stack:has(> .devmode-doc-outline.is-collapsed) > .devmode-doc-outline",
  );
  assert.match(outline, /border-top:\s*0/);
  assert.match(outline, /border-top-left-radius:\s*0/);
  assert.match(outline, /border-top-right-radius:\s*0/);
});

test("expanded outline keeps the pane gap and its own card", () => {
  // The base stack still spaces the cards by exactly one gap; only the
  // collapsed variant zeroes it.
  assert.match(rule(".devmode-sidebar-stack"), /gap:\s*var\(--devmode-pane-gap, 8px\)/);
  // Un-collapsed, the outline card keeps all four edges: the top border is
  // dropped only by the `:has(... .is-collapsed)` variant above.
  const cards = rule(".devmode-files-card,\n.devmode-doc-outline");
  assert.match(cards, /border: 1px solid var\(--devmode-pane-border/);
  assert.doesNotMatch(cards, /border-top:\s*0/);
  // One height source for the expanded card, still on the shared token.
  assert.match(
    css,
    /\n\.devmode-doc-outline \{\n  flex: 0 0 var\(--devmode-doc-outline-height, 180px\);/,
  );
  // The gutter handle still swallows exactly one gap via negative margins.
  const handle = rule(".devmode-doc-outline-resize");
  assert.match(handle, /margin:\s*calc\(-1 \* var\(--devmode-pane-gap, 8px\)\) 0/);
});
