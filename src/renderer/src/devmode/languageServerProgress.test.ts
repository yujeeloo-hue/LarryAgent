import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLanguageServerProgress,
  createLanguageServerProgressState,
  formatLanguageServerProgressParts,
  languageServerProgressNeedsTick,
} from "./languageServerProgress.js";

const WS = "E:\\Game";
const SCRIPTS = "E:/Game/Content/Script";

function texts(state: ReturnType<typeof createLanguageServerProgressState>, root: string | null, now: number): string[] {
  return formatLanguageServerProgressParts(state, root, now).map(part => part.text);
}

test("Lua loading keeps one clock from start to the end of indexing and shows the server message", () => {
  const state = createLanguageServerProgressState();
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "starting" }, 1_000);
  assert.equal(languageServerProgressNeedsTick(state), true);
  assert.deepEqual(texts(state, WS, 1_400), ["Starting Lua language server… 0s"]);
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "loading" }, 1_500);
  applyLanguageServerProgress(
    state,
    { server: "lua", rootPath: SCRIPTS, phase: "loading", message: "Indexing 12000 files" },
    2_000,
  );
  assert.deepEqual(texts(state, WS, 4_200), ["Loading Lua workspace… 3s · Indexing 12,000 files"]);
});

test("diagnosis shows its percentage without a clock, and idle clears the status", () => {
  const state = createLanguageServerProgressState();
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "loading" }, 0);
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "diagnosing" }, 1_000);
  assert.deepEqual(texts(state, WS, 1_000), ["Checking Lua files…"]);
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "diagnosing", percent: 42 }, 1_500);
  assert.equal(languageServerProgressNeedsTick(state), false);
  assert.deepEqual(texts(state, WS, 9_000), ["Checking Lua files 42%"]);
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "idle" }, 2_000);
  assert.deepEqual(texts(state, WS, 2_000), []);
});

test("a failed start stays visible until the next attempt", () => {
  const state = createLanguageServerProgressState();
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "failed", message: "spawn EACCES" }, 0);
  assert.deepEqual(texts(state, WS, 0), ["Lua language server failed to start"]);
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "starting" }, 5_000);
  assert.deepEqual(texts(state, WS, 5_000), ["Starting Lua language server… 0s"]);
});

test("TypeScript and Lua on the same root are tracked separately", () => {
  const state = createLanguageServerProgressState();
  applyLanguageServerProgress(state, { server: "typescript", rootPath: WS, phase: "starting" }, 0);
  applyLanguageServerProgress(state, { server: "lua", rootPath: WS, phase: "loading" }, 0);
  assert.deepEqual(texts(state, WS, 2_000), [
    "Starting TypeScript language server… 2s",
    "Loading Lua workspace… 2s",
  ]);
  applyLanguageServerProgress(state, { server: "typescript", rootPath: WS, phase: "loading", message: "Loading project" }, 3_000);
  assert.deepEqual(texts(state, WS, 4_000)[0], "Loading TypeScript project… 4s · Loading project");
  applyLanguageServerProgress(state, { server: "typescript", rootPath: WS, phase: "idle" }, 5_000);
  assert.deepEqual(texts(state, WS, 5_000), ["Loading Lua workspace… 5s"]);
});

test("only roots inside the open workspace are shown", () => {
  const state = createLanguageServerProgressState();
  applyLanguageServerProgress(state, { server: "lua", rootPath: SCRIPTS, phase: "loading" }, 0);
  applyLanguageServerProgress(state, { server: "lua", rootPath: "E:/GameTools/Lua", phase: "loading" }, 0);
  const parts = formatLanguageServerProgressParts(state, WS, 0);
  assert.deepEqual(parts.map(part => part.key), ["lua:e:/game/content/script"]);
  assert.deepEqual(texts(state, null, 0), []);
  assert.equal(texts(state, "E:/GameTools", 0).length, 1);
});
