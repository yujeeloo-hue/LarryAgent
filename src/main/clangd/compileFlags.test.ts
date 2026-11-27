import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CompileDbInspector,
  expandResponseFiles,
  summarizeArgs,
  tokenizeCommandLine,
} from "./compileFlags.js";

test("tokenizer keeps quoted paths whole and strips the quotes", () => {
  assert.deepEqual(
    tokenizeCommandLine('"C:/Program Files/LLVM/bin/clang-cl.exe" @"../x.rsp" /FI"E:/a b/Definitions.h"'),
    ["C:/Program Files/LLVM/bin/clang-cl.exe", "@../x.rsp", "/FIE:/a b/Definitions.h"],
  );
});

test("summary counts include dirs, defines, forced includes and PCH flags", () => {
  const summary = summarizeArgs([
    "/I", "Runtime/Core/Public",
    "-IRuntime/Engine/Public",
    "/external:I", "C:/SDK",
    "/DWITH_EDITOR=1",
    "-D", "UE_BUILD_DEBUG=1",
    "/FIE:/NF/Definitions.h",
    "-include", "E:/NF/SharedPCH.Engine.h",
    "/YuSharedPCH.Engine.h",
    "/c",
  ]);
  assert.equal(summary.includeDirs, 3);
  assert.equal(summary.defines, 2);
  assert.deepEqual(summary.forcedIncludes, ["Definitions.h", "SharedPCH.Engine.h"]);
  assert.deepEqual(summary.pchFlags, ["/YuSharedPCH.Engine.h"]);
});

test("inspector resolves include dirs for headers via their module translation unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "clangd-includes-"));
  try {
    await writeFile(
      join(root, "compile_commands.json"),
      JSON.stringify([
        {
          file: "E:/NF/Source/NF/Private/NFActor.cpp",
          command: 'clang-cl.exe @NFActor.cpp.obj.rsp',
          directory: root,
        },
        {
          file: "E:/NF/Engine/Source/Runtime/Engine/Private/Engine.cpp",
          arguments: [
            "clang-cl.exe",
            "/IE:/NF/Source/NF/Public",
            "/IE:/NF/Engine/Source/Runtime/Engine/Public",
            "-isystem", "E:/SDK/Include",
          ],
          directory: "E:/NF",
        },
      ]),
    );
    await writeFile(
      join(root, "NFActor.cpp.obj.rsp"),
      '/I "E:/NF/Source/NF/Public"\n/I "E:/NF/Source/NF/Private"\n/c\n',
    );
    const inspector = new CompileDbInspector(root);
    assert.deepEqual(await inspector.includeDirs("E:/NF/Source/NF/Private/NFActor.cpp"),
      ["E:/NF/Source/NF/Public", "E:/NF/Source/NF/Private"]);
    assert.deepEqual(await inspector.includeDirs("E:/NF/Source/NF/Public/NFCharacter.h"),
      ["E:/NF/Source/NF/Public", "E:/NF/Source/NF/Private"]);
    assert.deepEqual(
      await inspector.includeDirs("E:/NF/Engine/Source/Runtime/Engine/Public/GameFramework/Actor.h"),
      ["E:/NF/Source/NF/Public", "E:/NF/Engine/Source/Runtime/Engine/Public", "E:/SDK/Include"],
    );
    assert.deepEqual(await inspector.includeDirs("D:/Elsewhere/Thing.h"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UBT-style nested response files expand relative to the entry directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clangd-flags-"));
  try {
    await writeFile(join(root, "Shared.rsp"), '/I "Runtime/Core/Public"\n/I "Runtime/Engine/Public"\n');
    await writeFile(
      join(root, "File.cpp.obj.rsp"),
      `"E:/NF/File.cpp"\n@"${join(root, "Shared.rsp").replace(/\\/g, "/")}"\n/FI"E:/NF/Definitions.h"\n/c\n`,
    );
    const expanded = await expandResponseFiles(["clang-cl.exe", "@File.cpp.obj.rsp"], root);
    assert.equal(expanded.responseFiles, 2);
    const summary = summarizeArgs(expanded.args, expanded.responseFiles);
    assert.equal(summary.includeDirs, 2);
    assert.deepEqual(summary.forcedIncludes, ["Definitions.h"]);

    await writeFile(
      join(root, "compile_commands.json"),
      JSON.stringify([
        { file: "E:/NF/File.cpp", command: 'clang-cl.exe @"File.cpp.obj.rsp"', directory: root },
      ]),
    );
    const inspector = new CompileDbInspector(root);
    const viaDb = await inspector.inspect("e:\\NF\\File.cpp");
    assert.equal(viaDb?.includeDirs, 2);
    assert.equal(await inspector.inspect("E:/NF/Missing.cpp"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
