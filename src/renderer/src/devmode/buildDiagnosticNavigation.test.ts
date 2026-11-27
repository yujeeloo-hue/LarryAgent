import assert from "node:assert/strict";
import test from "node:test";
import { revealBuildDiagnostic } from "./buildDiagnosticNavigation.js";
import { parseBuildDiagnostic } from "./buildDiagnostics.js";

test("relative compiler paths open in the workspace with their reported cursor location", async () => {
  const item = parseBuildDiagnostic("Source/Actor.cpp(142,9): error C2065: missing name")!;
  const calls: unknown[] = [];
  await revealBuildDiagnostic(item, "E:/Game", {
    getWorkspacePath: () => "E:/Game",
    filterExistingFiles: async paths => { calls.push(paths); return paths; },
    resolveSourcePath: async () => { throw Error("should not search for an existing file"); },
    revealFileLine: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls, [["E:/Game/Source/Actor.cpp"], ["E:/Game/Source/Actor.cpp", 142, 9]]);
});

test("engine/build-machine paths reuse the source mapper, including warnings without a column", async () => {
  const item = parseBuildDiagnostic("D:/Build/Engine/Source/Actor.cpp(42): warning C4100: unused")!;
  let revealed: unknown;
  await revealBuildDiagnostic(item, "/game", {
    getWorkspacePath: () => "/game", filterExistingFiles: async () => [],
    resolveSourcePath: async (root, path) => { assert.equal(root, "/game"); assert.equal(path, item.path); return "/UE/Engine/Source/Actor.cpp"; },
    revealFileLine: async (...args) => { revealed = args; },
  });
  assert.deepEqual(revealed, ["/UE/Engine/Source/Actor.cpp", 42, 1]);
});

test("a project switch while resolving or an unlocated diagnostic never opens a stale file", async () => {
  let root = "/game", opened = false;
  const deps = {
    getWorkspacePath: () => root,
    filterExistingFiles: async () => [],
    resolveSourcePath: async () => { root = "/other"; return "/game/Actor.cpp"; },
    revealFileLine: async () => { opened = true; },
  };
  await revealBuildDiagnostic(parseBuildDiagnostic("Actor.cpp(5): error C2001: bad")!, "/game", deps);
  assert.equal(opened, false);
  root = "/game";
  await revealBuildDiagnostic(parseBuildDiagnostic("LINK : fatal error LNK1104: missing library")!, "/game", deps);
  assert.equal(opened, false);
});
