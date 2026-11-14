import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  frameModuleKeys,
  frameModuleLabel,
  frameSourceFile,
  moduleKeysOf,
} from "./frameSource.js";

describe("frameSourceFile", () => {
  it("keeps a real compile-time source path", () => {
    assert.equal(
      frameSourceFile({
        name: "AFoo::Tick",
        line: 42,
        source: {
          name: "Foo.cpp",
          path: "D:/build/Project/Source/NF/Foo.cpp",
        },
      }),
      "D:/build/Project/Source/NF/Foo.cpp",
    );
  });

  it("rejects the disassembly source lldb-dap returns for a skipped module", () => {
    assert.equal(
      frameSourceFile({
        name: "FMemory::Malloc",
        line: 42,
        source: {
          name: "UnrealEditor-Core.dll`FMemory::Malloc",
          path: "E:/UE/Engine/Binaries/Win64/UnrealEditor-Core.dll",
          sourceReference: 1234,
        },
      }),
      null,
    );
  });

  it("rejects a module-only source even without a source reference", () => {
    assert.equal(
      frameSourceFile({
        name: "FMemory::Malloc",
        line: 0,
        source: { name: "UnrealEditor-Core.dll" },
      }),
      null,
    );
  });

  it("returns null when the frame has no source at all", () => {
    assert.equal(frameSourceFile({ name: "??", line: 0 }), null);
  });
});

describe("frameModuleLabel", () => {
  it("reads the module from a disassembly source path", () => {
    assert.equal(
      frameModuleLabel({
        name: "FMemory::Malloc",
        line: 42,
        source: {
          name: "UnrealEditor-Core.dll`FMemory::Malloc",
          path: "E:/UE/Engine/Binaries/Win64/UnrealEditor-Core.dll",
          sourceReference: 1234,
        },
      }),
      "UnrealEditor-Core.dll",
    );
  });

  it("reads the module from an LLDB backtick frame name", () => {
    assert.equal(
      frameModuleLabel({
        name: "UnrealEditor-Engine.dll`UWorld::Tick",
        line: 0,
      }),
      "UnrealEditor-Engine.dll",
    );
  });

  it("reads the module from an MSVC-style frame name", () => {
    assert.equal(
      frameModuleLabel({ name: "UnrealEditor-Core!FMemory::Malloc", line: 0 }),
      "UnrealEditor-Core",
    );
  });

  it("does not mistake a plain function name for a module", () => {
    assert.equal(frameModuleLabel({ name: "AFoo::Tick", line: 12 }), null);
  });
});

describe("frameModuleKeys / moduleKeysOf", () => {
  it("matches a module list entry by basename or stem", () => {
    const keys = frameModuleKeys({
      name: "UnrealEditor-Core!FMemory::Malloc",
      line: 0,
    });
    assert.ok(
      moduleKeysOf("E:/UE/Engine/Binaries/Win64/UnrealEditor-Core.dll").some(
        (key) => keys.includes(key),
      ),
    );
  });

  it("does not match a different module", () => {
    const keys = frameModuleKeys({
      name: "UnrealEditor-Core.dll`FMemory::Malloc",
      line: 0,
    });
    assert.ok(
      !moduleKeysOf("E:/UE/Engine/Binaries/Win64/UnrealEditor-Engine.dll").some(
        (key) => keys.includes(key),
      ),
    );
  });
});
