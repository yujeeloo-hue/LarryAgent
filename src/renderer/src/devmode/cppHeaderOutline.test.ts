import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCppHeaderPath,
  isCppSourcePath,
  scanCppHeader,
  siblingHeaderCandidates,
  siblingSourceCandidates,
} from "./cppHeaderOutline.js";
import { scanDocumentSymbols } from "./documentSymbols.js";

const UNREAL_HEADER = [
  "#pragma once",
  "UCLASS()",
  "class AMyActor : public AActor",
  "{",
  "    GENERATED_BODY()",
  "public:",
  "    AMyActor();",
  "    UPROPERTY(EditAnywhere)",
  "    int32 Health;",
  "    UFUNCTION(BlueprintCallable)",
  "    void BeginPlay();",
  "    void Tick(float DeltaTime);",
  "private:",
  "    void TickInternal();",
  "    bool bReady;",
  "};",
].join("\n");

describe("cpp path helpers", () => {
  it("classifies headers and sources", () => {
    assert.equal(isCppHeaderPath("E:/Game/Public/MyActor.h"), true);
    assert.equal(isCppHeaderPath("Foo.hpp"), true);
    assert.equal(isCppSourcePath("E:/Game/Private/MyActor.cpp"), true);
    assert.equal(isCppSourcePath("MyActor.h"), false);
  });

  it("maps Unreal Private sources onto Public headers", () => {
    const candidates = siblingHeaderCandidates(
      "E:/Game/Source/Foo/Private/MyActor.cpp",
    );
    assert.equal(
      candidates.includes("E:/Game/Source/Foo/Public/MyActor.h"),
      true,
    );
    assert.equal(
      candidates.includes("E:/Game/Source/Foo/Private/MyActor.h"),
      true,
    );
  });

  it("maps engine Private sources onto Classes headers", () => {
    const candidates = siblingHeaderCandidates(
      "E:/UE/Engine/Source/Runtime/Engine/Private/GameFramework/PlayerController.cpp",
    );
    assert.equal(
      candidates.includes(
        "E:/UE/Engine/Source/Runtime/Engine/Public/GameFramework/PlayerController.h",
      ),
      true,
    );
    assert.equal(
      candidates.includes(
        "E:/UE/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
      ),
      true,
    );
  });

  it("maps module-root sources into Public/ and Classes/", () => {
    const candidates = siblingHeaderCandidates(
      "E:/Game/Source/MyGame/MyGame.cpp",
    );
    assert.equal(
      candidates.includes("E:/Game/Source/MyGame/MyGame.h"),
      true,
    );
    assert.equal(
      candidates.includes("E:/Game/Source/MyGame/Public/MyGame.h"),
      true,
    );
    assert.equal(
      candidates.includes("E:/Game/Source/MyGame/Classes/MyGame.h"),
      true,
    );
  });

  it("maps Unreal Public headers onto Private sources (cpp first)", () => {
    const candidates = siblingSourceCandidates(
      "E:/Game/Source/Foo/Public/MyActor.h",
    );
    assert.equal(candidates[0], "E:/Game/Source/Foo/Public/MyActor.cpp");
    assert.equal(
      candidates.includes("E:/Game/Source/Foo/Private/MyActor.cpp"),
      true,
    );
    assert.equal(
      candidates.includes("E:/Game/Source/Foo/MyActor.cpp"),
      true,
    );
    assert.equal(
      candidates.some((candidate) => !candidate.endsWith(".cpp")),
      true,
    );
  });

  it("maps engine Public headers into nested Private dirs", () => {
    const candidates = siblingSourceCandidates(
      "E:/UE/Engine/Source/Runtime/Core/Public/HAL/UnrealMemory.h",
    );
    assert.equal(
      candidates.includes(
        "E:/UE/Engine/Source/Runtime/Core/Private/HAL/UnrealMemory.cpp",
      ),
      true,
    );
  });

  it("maps engine Classes headers onto Private sources", () => {
    const candidates = siblingSourceCandidates(
      "E:/UE/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
    );
    assert.equal(
      candidates[0],
      "E:/UE/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.cpp",
    );
    assert.equal(
      candidates.includes(
        "E:/UE/Engine/Source/Runtime/Engine/Private/GameFramework/PlayerController.cpp",
      ),
      true,
    );
  });

  it("maps plugin Public headers onto Private sources (flat and nested)", () => {
    const flat = siblingSourceCandidates(
      "E:/Game/Plugins/X/Source/XCore/Public/XSettings.h",
    );
    assert.equal(
      flat.includes("E:/Game/Plugins/X/Source/XCore/Private/XSettings.cpp"),
      true,
    );
    const nested = siblingSourceCandidates(
      "E:/Game/Plugins/X/Source/XCore/Public/Components/XWidgetComponent.h",
    );
    assert.equal(
      nested.includes(
        "E:/Game/Plugins/X/Source/XCore/Private/Components/XWidgetComponent.cpp",
      ),
      true,
    );
  });

  it("maps module-root headers into Private/", () => {
    const candidates = siblingSourceCandidates(
      "E:/Game/Source/MyGame/MyGame.h",
    );
    assert.equal(
      candidates.includes("E:/Game/Source/MyGame/MyGame.cpp"),
      true,
    );
    assert.equal(
      candidates.includes("E:/Game/Source/MyGame/Private/MyGame.cpp"),
      true,
    );
  });

  it("returns no source candidates for non-headers", () => {
    assert.deepEqual(
      siblingSourceCandidates("E:/Game/Private/MyActor.cpp"),
      [],
    );
    assert.deepEqual(siblingSourceCandidates("E:/Game/Foo.ts"), []);
  });
});

describe("scanCppHeader", () => {
  it("lists access-section functions and fields, skipping macros and bodies", () => {
    const symbols = scanCppHeader(UNREAL_HEADER);
    assert.deepEqual(
      symbols.map((s) => `${s.depth}:${s.kind}:${s.name}`),
      [
        "0:class:AMyActor",
        "1:access:public",
        "1:function:AMyActor",
        "1:variable:Health",
        "1:function:BeginPlay",
        "1:function:Tick",
        "1:access:private",
        "1:function:TickInternal",
        "1:variable:bReady",
      ],
    );
    const health = symbols.find((s) => s.name === "Health");
    assert.equal(health?.returnType, "int32");
    const tick = symbols.find((s) => s.name === "Tick");
    assert.equal(tick?.params, "float DeltaTime");
    assert.equal(tick?.returnType, "void");
    assert.equal(
      symbols.some((s) => /GENERATED|UPROPERTY|UFUNCTION/.test(s.name)),
      false,
    );
  });

  it("does not list locals inside inline function bodies", () => {
    const symbols = scanCppHeader(
      [
        "class Foo {",
        "public:",
        "    void Bar() {",
        "        int local = 1;",
        "    }",
        "    int Field;",
        "};",
      ].join("\n"),
    );
    assert.deepEqual(
      symbols.map((s) => s.name),
      ["Foo", "public", "Bar", "Field"],
    );
  });

  it("emits implicit public for struct members without a label", () => {
    const symbols = scanCppHeader(
      ["struct FThing {", "    int32 X;", "    void Reset();", "};"].join("\n"),
    );
    assert.deepEqual(
      symbols.map((s) => `${s.kind}:${s.name}`),
      ["struct:FThing", "access:public", "variable:X", "function:Reset"],
    );
  });

  it("skips file-scope helpers in the header", () => {
    const symbols = scanCppHeader(
      [
        "void Helper();",
        "class Foo {",
        "public:",
        "    void Bar();",
        "};",
      ].join("\n"),
    );
    assert.deepEqual(
      symbols.map((s) => s.name),
      ["Foo", "public", "Bar"],
    );
  });
});

describe("scanDocumentSymbols C++ routing", () => {
  it("does not scan implementation files when a path is given", () => {
    const text = [
      "void AMyActor::BeginPlay()",
      "{",
      "    Super::BeginPlay();",
      "}",
    ].join("\n");
    assert.deepEqual(scanDocumentSymbols(text, { path: "AMyActor.cpp" }), []);
  });

  it("scans headers when a header path is given", () => {
    const symbols = scanDocumentSymbols(UNREAL_HEADER, {
      path: "MyActor.h",
    });
    assert.equal(
      symbols.some((s) => s.name === "BeginPlay" && s.kind === "function"),
      true,
    );
    assert.equal(
      symbols.some((s) => s.name === "Health" && s.kind === "variable"),
      true,
    );
  });
});
