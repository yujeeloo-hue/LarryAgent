import assert from "node:assert/strict";
import test from "node:test";
import { supportsUnrealLiveCoding, unrealBuildCommand, withLiveCodingFlag } from "./liveCoding.js";

const editor = {
  id: "editor",
  kind: "native" as const,
  targetType: "Editor",
  buildReason: null,
  skipBuild: false,
  uproject: "E:/Game/Game.uproject",
  command: "call Build.bat GameEditor Win64 DebugGame -Project=Game.uproject -WaitMutex",
  rebuildCommand: "call Rebuild.bat GameEditor Win64 DebugGame -WaitMutex",
  cleanCommand: "call Clean.bat GameEditor Win64 DebugGame -WaitMutex",
};

test("Live Coding is a Windows Editor target with C++ sources", () => {
  assert.equal(supportsUnrealLiveCoding(editor, "win32"), true);
  assert.equal(supportsUnrealLiveCoding(editor, "darwin"), false);
  assert.equal(supportsUnrealLiveCoding({ ...editor, targetType: "Game" }, "win32"), false);
  assert.equal(supportsUnrealLiveCoding({ ...editor, kind: "managed" }, "win32"), false);
  assert.equal(supportsUnrealLiveCoding({ ...editor, skipBuild: true }, "win32"), false);
  assert.equal(supportsUnrealLiveCoding({ ...editor, buildReason: "no modules" }, "win32"), false);
  assert.equal(supportsUnrealLiveCoding({ ...editor, uproject: null }, "win32"), false);
});

test("Live Coding appends the flag to every UBT command and leaves other operations unchanged", () => {
  assert.equal(
    withLiveCodingFlag("call Build.bat A -WaitMutex && call Build.bat B -WaitMutex"),
    "call Build.bat A -WaitMutex -LiveCoding && call Build.bat B -WaitMutex -LiveCoding",
  );
  assert.equal(withLiveCodingFlag("call Build.bat A -LiveCoding -WaitMutex"), "call Build.bat A -LiveCoding -WaitMutex");
  assert.equal(unrealBuildCommand(editor, "liveCoding", "win32"), `${editor.command} -LiveCoding`);
  assert.equal(unrealBuildCommand(editor, "build", "win32"), editor.command);
  assert.equal(unrealBuildCommand(editor, "rebuild", "win32"), editor.rebuildCommand);
  assert.equal(unrealBuildCommand({ ...editor, targetType: "Game" }, "liveCoding", "win32"), undefined);
});
