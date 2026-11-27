import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const devmodeCss = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sheet.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

test("toolbar and panel buttons share a 6px status dot in the top-right corner", () => {
  const geometry = rule(devmodeCss, ".devmode-launch-btn:is(.is-running, .is-failed)::before,\n.devmode-panel-pip");
  assert.match(geometry, /position:\s*absolute/);
  assert.match(geometry, /top:\s*2px/);
  assert.match(geometry, /right:\s*calc\(2px - var\(--devmode-launch-separator-width, 0px\)\)/);
  assert.match(geometry, /width:\s*6px/);
  assert.match(geometry, /height:\s*6px/);
  assert.match(geometry, /border-radius:\s*50%/);
  assert.match(devmodeCss, /--devmode-launch-separator-width:\s*1px;\s*border-right:\s*var\(--devmode-launch-separator-width\)/);
});

test("running, successful and failed statuses use the state colors on the same sized dot", () => {
  const running = rule(devmodeCss, ".devmode-launch-btn.is-running::before,\n.devmode-panel-pip.is-running");
  const failed = rule(devmodeCss, ".devmode-launch-btn.is-failed::before,\n.devmode-panel-pip.is-failed");
  const succeeded = rule(devmodeCss, ".devmode-panel-pip.is-ok");
  assert.match(running, /background:\s*var\(--accent\)/);
  assert.match(running, /animation:\s*devmode-debug-pulse/);
  assert.match(succeeded, /background:\s*var\(--success\)/);
  assert.match(failed, /background:\s*var\(--danger-text\)/);
  for (const state of [running, failed, succeeded]) {
    assert.doesNotMatch(state, /\b(?:width|height|top|right|border):/);
  }
});

test("reduced motion stops both running dots from pulsing", () => {
  assert.match(
    devmodeCss,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.devmode-launch-btn\.is-running::before,\s*\.devmode-panel-pip\.is-running\s*\{[^}]*animation:\s*none/,
  );
});
