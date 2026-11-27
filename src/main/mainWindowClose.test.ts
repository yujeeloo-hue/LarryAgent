import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function closedHandler(): string {
  const match = source.match(/win\.on\("closed", \(\) => \{\n([\s\S]*?)\n {2}\}\);/);
  assert.ok(match, "main window has a closed handler");
  return match[1]!;
}

function beforeClosedHandler(): string {
  const at = source.indexOf('win.on("closed", () => {');
  assert.ok(at >= 0, "main window has a closed handler");
  const createAt = source.indexOf("async function createWindow");
  assert.ok(createAt >= 0 && createAt < at, "createWindow precedes the closed handler");
  return source.slice(createAt, at);
}

test("closed handler does not touch destroyed webContents", () => {
  const body = closedHandler();
  assert.doesNotMatch(body, /win\.webContents/);
  assert.match(body, /unbindBreakpointCallbacksForOwner\(webContentsId\)/);
  assert.match(body, /unbindStartCallbacksForOwner\(webContentsId\)/);
});

test("webContents id is captured while the window is alive", () => {
  const preamble = beforeClosedHandler();
  assert.match(preamble, /const webContentsId = win\.webContents\.id;/);
});
