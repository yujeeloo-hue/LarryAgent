import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listGameEditorShlibs } from "./gameModules.js";

describe("listGameEditorShlibs", () => {
  it("collects project and plugin editor DLLs and skips Engine", () => {
    // Use a host-native absolute path: node:path intentionally follows the
    // current platform, while DLL names remain Windows artifacts.
    const root = join("/", "game");
    const files = new Map<string, string[]>([
      [join(root, "Binaries", "Win64"), [
        "UnrealEditor-NF-Win64-DebugGame.dll",
        "UnrealEditor-NF.dll",
        "UnrealEditor.exe",
      ]],
      [join(root, "Plugins"), ["Foo"]],
      [join(root, "Plugins", "Foo", "Binaries", "Win64"), [
        "UnrealEditor-Foo-Win64-DebugGame.dll",
      ]],
      [join(root, "Engine", "Binaries", "Win64"), [
        "UnrealEditor-Engine-Win64-DebugGame.dll",
      ]],
    ]);
    const exists = (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "\\") || k.startsWith(p + "/"));
    const listDir = (dir: string) => {
      if (files.has(dir)) return files.get(dir) ?? [];
      if (dir === root) return ["Binaries", "Plugins", "Engine", "Source"];
      if (dir === join(root, "Plugins")) return ["Foo"];
      if (dir === join(root, "Plugins", "Foo")) return ["Binaries"];
      if (dir === join(root, "Engine")) return ["Binaries"];
      return [];
    };
    const names = listGameEditorShlibs(root, {
      exists,
      listDir,
      sourcePaths: [
        join(root, "Plugins", "Foo", "Source", "Foo", "Private", "Foo.cpp"),
      ],
    });
    assert.deepEqual(names, [
      "UnrealEditor-Foo-Win64-DebugGame.dll",
      "UnrealEditor-NF-Win64-DebugGame.dll",
    ]);
  });
});
