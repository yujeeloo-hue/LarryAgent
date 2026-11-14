import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** CSS gate for the Dev Mode Detail drawer card (dev-tools-devmode.css).
 *
 * Two regressions this file pins:
 * 1. Dev Mode must keep the flat shell's drawer open/close motion — the
 *    card variant once set `transition: none`, making the panel pop in
 *    and out with no animation.
 * 2. The height-resize highlight must speak the same splitter vocabulary
 *    as the workbench card gaps (devmode.css `.app-shell-resize::before`):
 *    a 2px rounded `--pane-divider-hover` pill faded via opacity, not a
 *    bespoke 1px accent hairline.
 */
const css = readFileSync(new URL("./dev-tools-devmode.css", import.meta.url), "utf8");
const shellCss = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");
const devmodeCss = readFileSync(new URL("../devmode/devmode.css", import.meta.url), "utf8");

function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Line-anchored so prefixed variants (:root[data-theme=…] …) never match.
  const match = sheet.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

test("dev-mode drawer keeps the shell drawer animation", () => {
  const base = rule(css, ".app-shell.is-dev-mode .app-shell-drawer");
  // Same clock as the flat drawer in shell.css.
  assert.match(base, /transition:[\s\S]*?flex-basis 180ms ease/);
  assert.doesNotMatch(base, /transition:\s*none/);
  assert.match(shellCss, /\.app-shell-drawer\s*\{[\s\S]*?transition:\s*flex-basis 180ms ease/);
});

test("dev-mode card chrome interpolates from the closed zero-footprint state", () => {
  const base = rule(css, ".app-shell.is-dev-mode .app-shell-drawer");
  assert.match(base, /margin-top:\s*0/);
  assert.match(base, /border:\s*0 solid var\(--devmode-pane-border\)/);
  assert.match(base, /background:\s*transparent/);
  assert.match(base, /transition:[\s\S]*?margin-top 180ms ease/);
  assert.match(base, /transition:[\s\S]*?border-width 180ms ease/);

  const open = rule(css, ".app-shell.is-dev-mode .app-shell-drawer.is-open");
  // Width-only override — the `border:` shorthand would snap border-style.
  assert.match(open, /border-width:\s*1px/);
  assert.doesNotMatch(open, /border:\s*1px/);
  assert.match(open, /margin-top:\s*var\(--devmode-pane-gap\)/);
});

test("drawer drag-resize stays 1:1 with the pointer in dev mode", () => {
  // dev-tools-devmode.css loads after shell.css, so its own transition list
  // would out-rank shell's flat `.is-drawer-resizing` guard — the guard must
  // be restated at dev-mode specificity.
  const guard = rule(css, ".app-shell.is-dev-mode.is-drawer-resizing .app-shell-drawer");
  assert.match(guard, /transition:\s*none/);
});

test("drawer resize highlight matches the workbench splitter vocabulary", () => {
  const pill = rule(css, ".app-shell.is-dev-mode .app-shell-drawer-resize::before");
  assert.match(pill, /height:\s*2px/);
  assert.match(pill, /border-radius:\s*2px/);
  assert.match(pill, /background:\s*var\(--pane-divider-hover\)/);
  assert.match(pill, /opacity:\s*0/);
  assert.match(pill, /transition:\s*opacity 120ms ease/);

  const hover = rule(
    css,
    ".app-shell.is-dev-mode .app-shell-drawer-resize:is(:hover, :focus-visible, .is-dragging)::before",
  );
  assert.match(hover, /opacity:\s*1/);
  assert.doesNotMatch(hover, /background:/);

  // Cross-file: the drawer pill must track the card-gap splitters it mirrors.
  const splitter = devmodeCss.match(
    /\.app-shell\.is-dev-mode \.app-shell-resize::before,\s*\n\.devmode-chat-split::before\s*\{([\s\S]*?)\}/,
  );
  assert.ok(splitter, "missing workbench splitter ::before rule in devmode.css");
  assert.match(splitter[1], /width:\s*2px/);
  assert.match(splitter[1], /background:\s*var\(--pane-divider-hover\)/);
});
