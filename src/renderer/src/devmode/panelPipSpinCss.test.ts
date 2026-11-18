import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const devmodeCss = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");
const spinnersCss = readFileSync(new URL("../styles/spinners.css", import.meta.url), "utf8");

function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sheet.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

test("running pip uses an even box so the 22px tab centres it on whole pixels", () => {
  const pip = rule(devmodeCss, ".devmode-panel-pip.is-running");
  const width = pip.match(/width:\s*(\d+)px/);
  const height = pip.match(/height:\s*(\d+)px/);
  assert.ok(width && height, "pip must size itself in whole px");
  assert.equal(width[1], height[1], "pip box must stay square");
  assert.equal(Number(width[1]) % 2, 0, "odd size = half-pixel centering = wobble");
});

test("running pip keeps the border ring and the shared spin animation", () => {
  const pip = rule(devmodeCss, ".devmode-panel-pip.is-running");
  assert.match(pip, /border:\s*[\d.]+px solid var\(--accent\)/);
  assert.match(pip, /border-top-color:\s*transparent/);
  assert.match(pip, /animation:\s*devmode-action-spin/);
});

test("running pip gets its own layer instead of re-rasterizing per frame", () => {
  assert.match(rule(devmodeCss, ".devmode-panel-pip.is-running"), /will-change:\s*transform/);
});

test("spinners.css keeps the ring centred on its border box", () => {
  const base = spinnersCss.match(
    /\.devmode-panel-pip\.is-running[\s\S]{0,900}?\}/,
  );
  assert.ok(base, "pip missing from the shared spinner geometry list");
  assert.match(base[0], /transform-origin:\s*50% 50%/);
  assert.match(base[0], /transform-box:\s*border-box/);
  assert.match(base[0], /flex-shrink:\s*0/);
});
