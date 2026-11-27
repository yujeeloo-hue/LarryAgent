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

function mixAlpha(value: string): number {
  const match = value.match(/color-mix\(in srgb, var\(--bg-elevated\)\s+([\d.]+)%,\s*transparent\)/);
  assert.ok(match, `not a bg-elevated/transparent mix: ${value}`);
  return Number(match[1]);
}

test("progress row owns the plate tokens", () => {
  const row = rule(".devmode-panel-progress");
  const base = token(row, "--devmode-progress-stop-bg");
  const hover = token(row, "--devmode-progress-stop-bg-hover");

  assert.ok(mixAlpha(base) > 0, "plate must not be a full transparent no-op");
  assert.equal(token(row, "--devmode-progress-stop-blur"), "10px");
  assert.match(token(row, "--devmode-progress-stop-ring"), /^inset 0 0 0 1px rgba\(var\(--tint-rgb\)/);
  assert.match(token(row, "--devmode-progress-stop-ring-hover"), /^inset 0 0 0 1px rgba\(var\(--tint-rgb\)/);

  assert.ok(mixAlpha(hover) > mixAlpha(base), "hover must deepen the plate");
  assert.ok(mixAlpha(hover) < 100, "hover must stay translucent");
});

test("plate stays polarity-correct in both themes", () => {
  const row = rule(".devmode-panel-progress");
  for (const name of ["--devmode-progress-stop-bg", "--devmode-progress-stop-bg-hover"]) {
    const value = token(row, name);
    assert.match(value, /var\(--bg-elevated\)/);
    assert.doesNotMatch(value, /rgba?\(\s*(255|0)\s*,/);
  }
});

test("only the danger Stop in the progress row is plated", () => {
  const plate = rule(".devmode-panel-progress .devmode-panel-ghost.is-danger");
  assert.match(plate, /background:\s*var\(--devmode-progress-stop-bg\)/);
  assert.match(plate, /box-shadow:\s*var\(--devmode-progress-stop-ring\)/);
  assert.match(plate, /backdrop-filter:\s*blur\(var\(--devmode-progress-stop-blur\)\)/);
  assert.match(plate, /-webkit-backdrop-filter:\s*blur\(var\(--devmode-progress-stop-blur\)\)/);

  assert.match(rule(".devmode-panel-ghost"), /background:\s*none/);
});

test("hover keeps the plate instead of the strip mist", () => {
  const hover = rule(".devmode-panel-progress .devmode-panel-ghost.is-danger:hover:not(:disabled)");
  assert.match(hover, /background:\s*var\(--devmode-progress-stop-bg-hover\)/);
  assert.match(hover, /box-shadow:\s*var\(--devmode-progress-stop-ring-hover\)/);
  assert.doesNotMatch(hover, /--devmode-strip-hover-bg|var\(--hover\)/);
});

test("the indeterminate stripe animation is untouched", () => {
  const stripes = rule(".devmode-panel-progress.is-indeterminate");
  assert.match(stripes, /repeating-linear-gradient\(\s*150deg/);
  assert.match(stripes, /animation:\s*devmode-panel-progress-stripes/);
});
