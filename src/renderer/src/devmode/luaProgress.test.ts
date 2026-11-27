import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLuaProgress,
  createLuaProgressState,
  formatLuaProgressParts,
  luaProgressNeedsTick,
} from "./luaProgress.js";

const WS = "E:\\Game";
const SCRIPTS = "E:/Game/Content/Script";

function texts(state: ReturnType<typeof createLuaProgressState>, root: string | null, now: number): string[] {
  return formatLuaProgressParts(state, root, now).map(part => part.text);
}

test("loading keeps one clock from start to the end of indexing and shows the server message", () => {
  const state = createLuaProgressState();
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "starting" }, 1_000);
  assert.equal(luaProgressNeedsTick(state), true);
  assert.deepEqual(texts(state, WS, 1_400), ["Starting Lua language server… 0s"]);
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "loading" }, 1_500);
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "loading", message: "Indexing 12000 files" }, 2_000);
  assert.deepEqual(texts(state, WS, 4_200), ["Loading Lua workspace… 3s · Indexing 12,000 files"]);
});

test("diagnosis shows its percentage without a clock, and idle clears the status", () => {
  const state = createLuaProgressState();
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "loading" }, 0);
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "diagnosing" }, 1_000);
  assert.deepEqual(texts(state, WS, 1_000), ["Checking Lua files…"]);
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "diagnosing", percent: 42 }, 1_500);
  assert.equal(luaProgressNeedsTick(state), false);
  assert.deepEqual(texts(state, WS, 9_000), ["Checking Lua files 42%"]);
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "idle" }, 2_000);
  assert.deepEqual(texts(state, WS, 2_000), []);
});

test("a failed start stays visible until the next attempt", () => {
  const state = createLuaProgressState();
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "failed", message: "spawn EACCES" }, 0);
  assert.deepEqual(texts(state, WS, 0), ["Lua language server failed to start"]);
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "starting" }, 5_000);
  assert.deepEqual(texts(state, WS, 5_000), ["Starting Lua language server… 0s"]);
});

test("only Lua roots inside the open workspace are shown", () => {
  const state = createLuaProgressState();
  applyLuaProgress(state, { rootPath: SCRIPTS, phase: "loading" }, 0);
  applyLuaProgress(state, { rootPath: "E:/GameTools/Lua", phase: "loading" }, 0);
  const parts = formatLuaProgressParts(state, WS, 0);
  assert.deepEqual(parts.map(part => part.key), ["lua:e:/game/content/script"]);
  assert.deepEqual(texts(state, null, 0), []);
  assert.equal(texts(state, "E:/GameTools", 0).length, 1);
});
