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

function lastRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))];
  assert.ok(all.length, `missing rule: ${selector}`);
  return all[all.length - 1][2];
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `missing token: ${name}`);
  return match[1].replace(/\s+/g, " ").trim();
}

test("term panes own one head geometry", () => {
  const pane = rule(".devmode-panel-term");
  assert.equal(token(pane, "--devmode-pane-head-control"), "24px");
  assert.equal(token(pane, "--devmode-pane-head-pad-y"), "5px");
  assert.equal(token(pane, "--devmode-pane-head-pad-left"), "10px");
  assert.equal(token(pane, "--devmode-pane-head-pad-right"), "var(--devmode-pane-head-pad-y)");
});

test("Debug Console draws its toolbar from those tokens", () => {
  const toolbar = rule(".devmode-debug-console-toolbar");
  assert.equal(
    token(toolbar, "padding"),
    "var(--devmode-pane-head-pad-y) var(--devmode-pane-head-pad-right) var(--devmode-pane-head-pad-y) var(--devmode-pane-head-pad-left)",
  );
  assert.match(toolbar, /border-bottom:\s*1px solid var\(--divider\)/);
  assert.equal(token(rule(".devmode-debug-console-toolbar input"), "height"), "var(--devmode-pane-head-control)");
  const action = rule(".devmode-debug-console-action");
  assert.equal(token(action, "width"), "var(--devmode-pane-head-control)");
  assert.equal(token(action, "height"), "var(--devmode-pane-head-control)");
  assert.equal(token(action, "padding"), "0");
});

test("References head is the same height with the same insets", () => {
  const head = rule(".devmode-references-head");
  assert.match(head, /box-sizing:\s*border-box/);
  assert.match(
    head,
    /height:\s*calc\(\s*var\(--devmode-pane-head-control\)\s*\+\s*var\(--devmode-pane-head-pad-y\)\s*\+\s*var\(--devmode-pane-head-pad-y\)\s*\+\s*1px\s*\)/,
  );
  assert.equal(
    token(head, "padding"),
    "var(--devmode-pane-head-pad-y) var(--devmode-pane-head-pad-right) var(--devmode-pane-head-pad-y) var(--devmode-pane-head-pad-left)",
  );
  assert.match(head, /border-bottom:\s*1px solid var\(--divider\)/);
  assert.doesNotMatch(rule(".devmode-references-status"), /padding:/);
});

test("Terminal input row squares its Clear button in the corner", () => {
  const form = rule(".terminal-pane-form");
  assert.equal(token(form, "--terminal-pane-form-pad-y"), "6px");
  assert.equal(token(form, "--terminal-pane-form-pad-left"), "10px");
  assert.equal(token(form, "--terminal-pane-form-pad-right"), "var(--terminal-pane-form-pad-y)");
  assert.equal(
    token(form, "padding"),
    "var(--terminal-pane-form-pad-y) var(--terminal-pane-form-pad-right) var(--terminal-pane-form-pad-y) var(--terminal-pane-form-pad-left)",
  );
});

test("References Clear matches the Debug Console action", () => {
  const clear = lastRule(".devmode-references-clear");
  assert.equal(token(clear, "width"), "var(--devmode-pane-head-control)");
  assert.equal(token(clear, "height"), "var(--devmode-pane-head-control)");
  assert.equal(token(clear, "margin-left"), "auto");
  assert.match(
    css,
    /\.devmode-build-problems-clear,\s*\.devmode-references-clear\s*\{[^}]*width:\s*22px/,
  );
});
