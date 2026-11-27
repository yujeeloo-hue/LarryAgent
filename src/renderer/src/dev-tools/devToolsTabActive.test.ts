import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baseCss = readFileSync(new URL("./dev-tools.css", import.meta.url), "utf8");
const devmodeCss = readFileSync(new URL("./dev-tools-devmode.css", import.meta.url), "utf8");

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
