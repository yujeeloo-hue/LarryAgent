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

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `missing token: ${name}`);
  return match[1].trim();
}

test("light strip defines its own hover / selected tokens", () => {
  const light = rule(':root[data-theme="light"] .devmode-panel-tabs');
  assert.match(token(light, "--devmode-strip-hover-bg"), /^rgba\(255, 255, 255/);
  assert.match(token(light, "--devmode-strip-on-bg"), /^#ffffff$/i);
  assert.equal(token(light, "--devmode-strip-on-fg"), "var(--accent)");
  assert.match(token(light, "--devmode-strip-hover-ring"), /inset 0 0 0 1px/);
  assert.match(token(light, "--devmode-strip-on-ring"), /inset 0 0 0 1px/);
  assert.match(token(light, "--devmode-strip-on-shadow"), /^0 1px 2px/);
});

test("hover and selected never resolve to the same fill", () => {
  const light = rule(':root[data-theme="light"] .devmode-panel-tabs');
  assert.notEqual(
    token(light, "--devmode-strip-hover-bg"),
    token(light, "--devmode-strip-on-bg"),
  );
});

test("strip tab hover is the white mist, selected is the white pill", () => {
  const hover = rule(".devmode-panel-tab:hover");
  assert.match(hover, /background:\s*var\(--devmode-strip-hover-bg, var\(--hover\)\)/);
  assert.match(hover, /box-shadow:\s*var\(--devmode-strip-hover-ring, none\)/);

  const on = rule(".devmode-panel-tab.is-on");
  assert.match(on, /background:\s*var\(--devmode-strip-on-bg,/);
  assert.match(on, /color:\s*var\(--devmode-strip-on-fg,/);
  assert.match(on, /box-shadow:\s*var\(--devmode-strip-on-ring, none\), var\(--devmode-strip-on-shadow, none\)/);
});

test("ghost buttons share the mist but draw no hairline chip", () => {
  const ghost = rule(".devmode-panel-ghost:hover:not(:disabled)");
  assert.match(ghost, /background:\s*var\(--devmode-strip-hover-bg, var\(--hover\)\)/);
  assert.doesNotMatch(ghost, /box-shadow/);
});

test("dark keeps the accent-tint fallbacks", () => {
  assert.doesNotMatch(
    css,
    /:root\[data-theme="dark"\] \.devmode-panel-tabs\s*\{/,
  );
  assert.doesNotMatch(css, /\.devmode-panel\s*\{[^}]*--devmode-strip-on-bg/);
  assert.match(rule(".devmode-panel-tab.is-on"), /var\(--active, rgba\(255, 255, 255, 0\.1\)\)/);
});
