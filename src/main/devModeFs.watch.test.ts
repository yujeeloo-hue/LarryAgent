import assert from "node:assert/strict";
import test from "node:test";
import { isWatchableRelPath } from "./devModeFs.js";

test("task config edits reach the renderer even though .larry is a dot directory", () => {
  assert.equal(isWatchableRelPath(".larry/tasks.json"), true);
  assert.equal(isWatchableRelPath(".larry\\tasks.json"), true);
  assert.equal(isWatchableRelPath("./.larry/tasks.json"), true);
  assert.equal(isWatchableRelPath(".larry/nested/tasks.json", { mode: "walk", unreal: false }), false);
});

test("ordinary sources stay watchable and other dot paths stay quiet", () => {
  assert.equal(isWatchableRelPath("src/index.ts"), true);
  assert.equal(isWatchableRelPath("Source/Game/Actor.cpp"), true);
  assert.equal(isWatchableRelPath(".git/index"), false);
  assert.equal(isWatchableRelPath(".git/config"), false);
  assert.equal(isWatchableRelPath(".larry/other.json"), false);
  assert.equal(isWatchableRelPath("node_modules/pkg/index.js"), false);
  assert.equal(isWatchableRelPath(""), false);
});
