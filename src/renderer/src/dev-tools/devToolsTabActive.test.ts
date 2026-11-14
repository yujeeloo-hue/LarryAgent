import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Active-state gate for the Detail tabs (both contexts, both themes).
 *
 * 2026-11-11 detail-tab-active demo decision (recipe C, scope both):
 * Dark active = accent text + 12% accent tint + neutral border, no accent
 * echo on borders; Dev Mode additionally drops the inset shadow that sat
 * at ~1.05:1 against the header. Light keeps the established quiet pills
 * in both contexts — restored via explicit :root[data-theme="light"]
 * overrides. Pins all four combinations so a future refactor can't
 * silently drop either theme's half.
 */
const baseCss = readFileSync(new URL("./dev-tools.css", import.meta.url), "utf8");
const devmodeCss = readFileSync(new URL("./dev-tools-devmode.css", import.meta.url), "utf8");

/** Slice the full rule block for a selector anchor (multi-line-safe). */
function rule(css: string, selector: string): string {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `missing rule: ${selector}`);
  const end = css.indexOf("}", i);
  assert.ok(end >= 0, `unterminated rule: ${selector}`);
  return css.slice(i, end + 1);
}

test("flat drawer Dark active is the accent text + tint recipe", () => {
  const r = rule(baseCss, ".dev-tools-tab.is-active");
  assert.match(r, /color:\s*var\(--accent\)/);
  assert.match(r, /background:\s*rgba\(var\(--accent-rgb\),\s*0\.12\)/);
  // Neutral brighter border — no accent echo on Dark control borders.
  assert.match(r, /border-color:\s*rgba\(var\(--tint-rgb\),\s*0\.14\)/);
});

test("flat drawer Light restores the quiet neutral pill", () => {
  const r = rule(baseCss, ':root[data-theme="light"] .dev-tools-tab.is-active');
  assert.match(r, /color:\s*var\(--fg\)/);
  assert.match(r, /border-color:\s*var\(--border\)/);
  assert.match(r, /background:\s*rgba\(var\(--tint-rgb\),\s*0\.06\)/);
});

test("Dev Mode Dark active is the accent recipe with no inset shadow", () => {
  const r = rule(devmodeCss, ".app-shell.is-dev-mode .dev-tools-tab.is-active");
  assert.match(r, /color:\s*var\(--accent\)/);
  assert.match(r, /background:\s*rgba\(var\(--accent-rgb\),\s*0\.12\)/);
  assert.match(r, /box-shadow:\s*none/);
  // The old near-invisible dark inset pill is gone from the Dark path.
  assert.doesNotMatch(r, /--detail-header-active/);
});

test("Dev Mode Light keeps the raised white pill", () => {
  const r = rule(
    devmodeCss,
    ':root[data-theme="light"] .app-shell.is-dev-mode .dev-tools-tab.is-active'
  );
  assert.match(r, /color:\s*var\(--fg\)/);
  assert.match(r, /background:\s*var\(--detail-header-active\)/);
  assert.match(r, /box-shadow:\s*0 1px 2px rgba\(var\(--shade-rgb\),\s*0\.1\)/);
});
