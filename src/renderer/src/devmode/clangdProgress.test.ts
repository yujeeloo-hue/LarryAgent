import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyClangdProgress,
  clangdProgressNeedsTick,
  createClangdProgressState,
  formatClangdProgress,
  formatClangdProgressParts,
  formatElapsed,
} from "./clangdProgress.js";

const CPP = "E:/Game/Source/NFCharacter.cpp";

test("starting shows a live elapsed clock and needs ticking", () => {
  const state = createClangdProgressState();
  applyClangdProgress(state, { phase: "starting" }, 1_000);
  assert.equal(clangdProgressNeedsTick(state), true);
  assert.equal(formatClangdProgress(state, 4_200), "clangd: starting… 3s");
  applyClangdProgress(state, { phase: "ready" }, 5_000);
  assert.equal(formatClangdProgress(state, 5_000), "");
  assert.equal(clangdProgressNeedsTick(state), false);
});

test("preamble build keeps its clock across repeated reports, then clears on idle", () => {
  const state = createClangdProgressState();
  applyClangdProgress(state, { phase: "file", path: CPP, state: "preamble" }, 0);
  applyClangdProgress(state, { phase: "file", path: CPP, state: "preamble" }, 5_000);
  assert.equal(
    formatClangdProgress(state, 72_000),
    "clangd: building preamble NFCharacter.cpp 1m 12s",
  );
  applyClangdProgress(state, { phase: "file", path: CPP, state: "parsing" }, 80_000);
  assert.equal(formatClangdProgress(state, 81_000), "clangd: parsing NFCharacter.cpp 1s");
  applyClangdProgress(state, { phase: "file", path: CPP.replace(/\//g, "\\"), state: "idle" }, 82_000);
  assert.equal(formatClangdProgress(state, 82_000), "");
});

test("active file wins, other builds are counted; index joins the line", () => {
  const state = createClangdProgressState();
  applyClangdProgress(state, { phase: "file", path: CPP, state: "preamble" }, 0);
  applyClangdProgress(state, { phase: "file", path: "E:/Game/Source/Other.cpp", state: "preamble" }, 1_000);
  applyClangdProgress(state, { phase: "indexing", percent: 34, message: "1200/3500" }, 1_000);
  assert.equal(
    formatClangdProgress(state, 10_000, CPP),
    "clangd: building preamble NFCharacter.cpp 10s (+1) · clangd index 34% 1200/3500",
  );
  applyClangdProgress(state, { phase: "failed" }, 11_000);
  assert.equal(formatClangdProgress(state, 11_000, CPP), "");
});

test("index loading shows its own clock after start, cleared on index_ready", () => {
  const state = createClangdProgressState();
  applyClangdProgress(state, { phase: "starting" }, 0);
  applyClangdProgress(state, { phase: "ready" }, 1_500);
  applyClangdProgress(state, { phase: "index_loading" }, 1_500);
  assert.equal(clangdProgressNeedsTick(state), true);
  assert.equal(formatClangdProgress(state, 13_500), "clangd: loading index… 12s");
  applyClangdProgress(state, { phase: "file", path: CPP, state: "preamble" }, 2_000);
  assert.equal(
    formatClangdProgress(state, 13_500, CPP),
    "clangd: loading index… 12s · clangd: building preamble NFCharacter.cpp 11s",
  );
  applyClangdProgress(state, { phase: "index_ready" }, 30_000);
  assert.equal(formatClangdProgress(state, 30_000, CPP), "clangd: building preamble NFCharacter.cpp 28s");
});

test("generating keeps one clock and then hands off to clangd start", () => {
  const state = createClangdProgressState();
  applyClangdProgress(state, { phase: "generating", message: "UnrealEditor · Mac · Development" }, 0);
  applyClangdProgress(state, { phase: "generating", message: "Creating target..." }, 5_000);
  assert.equal(clangdProgressNeedsTick(state), true);
  assert.equal(
    formatClangdProgress(state, 65_000),
    "clangd: generating compile database… 1m 05s (Creating target...)",
  );
  applyClangdProgress(state, { phase: "starting" }, 70_000);
  assert.equal(formatClangdProgress(state, 70_000), "clangd: starting… 0s");
});

test("elapsed formatting", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(125_000), "2m 05s");
});

test("progress parts keep stable keys while their text ticks", () => {
  const state = createClangdProgressState();
  applyClangdProgress(state, { phase: "index_loading" }, 1_000);
  applyClangdProgress(state, { phase: "file", path: CPP, state: "preamble" }, 1_000);
  applyClangdProgress(state, { phase: "indexing", percent: 34, message: "1200/3500" }, 1_000);
  applyClangdProgress(state, { phase: "indexing_speed", speed: "full" }, 1_000);
  const parts = formatClangdProgressParts(state, 13_000, CPP);
  assert.deepEqual(parts.map(part => part.key), [
    "index-loading",
    `file:${CPP.replace(/\\/g, "/").toLowerCase()}`,
    "index",
  ]);
  assert.deepEqual(parts.map(part => part.text), [
    "clangd: loading index… 12s",
    "clangd: building preamble NFCharacter.cpp 12s",
    "clangd index 34% 1200/3500",
  ]);
  assert.ok(!parts.some(part => /full speed/i.test(part.text)), "full-speed indexing stays in the boost control, not the info bar");
  const later = formatClangdProgressParts(state, 14_000, CPP);
  assert.deepEqual(later.map(part => part.key), parts.map(part => part.key));
  assert.match(later[0]!.text, /13s/);
  assert.equal(
    formatClangdProgress(state, 14_000, CPP),
    "clangd: loading index… 13s · clangd: building preamble NFCharacter.cpp 13s · clangd index 34% 1200/3500",
  );
});
