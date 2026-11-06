import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CppWorkspaceIndex,
  buildCppFileList,
  coveringSymbolScanRoot,
  isCppIndexablePath,
  isCppSiblingFile,
  isSkippedSymbolDir,
  isSymbolIndexablePath,
  scanCppDeclSymbols,
  scanCppImplSymbols,
  scanCppIndexSymbols,
  scanIndexSymbols,
} from "./cppSymbolIndex.js";

const CPP_SAMPLE = `#include "ANFCharacter.h"
#include "GameFramework/CharacterMovementComponent.h"

ANFCharacter::ANFCharacter(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
    PrimaryActorTick.bCanEverTick = true;
}

void ANFCharacter::BeginPlay()
{
    Super::BeginPlay();
    UE_LOG(LogTemp, Warning, TEXT("hello %s"), *GetName());
    if (UNFUtils::CheckThing())
    {
        return;
    }
    float H = UNFHealthComponent::StaticClass()->GetName().Len() > 0 ? 1.0f : 0.0f;
    SomeCall(ANFUtils::Helper());
}

void ANFCharacter::LongSignature(
    int32 ParamA,
    float ParamB)
{
}

float ANFCharacter::TakeDamage(float Damage, const FDamageEvent& DamageEvent, AController* EventInstigator, AActor* DamageCauser)
{
    return Super::TakeDamage(Damage, DamageEvent, EventInstigator, DamageCauser);
}

void ANFCharacter::Tick(float DeltaSeconds)
{
    UNFHealthComponent::StaticApply(this);
}
`;

const HEADER_SAMPLE = `#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "NFCharacter.generated.h"

UCLASS()
class NFGAME_API ANFCharacter : public ACharacter
{
    GENERATED_BODY()

public:
    ANFCharacter(const FObjectInitializer& ObjectInitializer);

    UFUNCTION(BlueprintCallable, Category = "Combat")
    float TakeDamage(float Damage) override;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Stats")
    float Health = 100.f;

protected:
    virtual void BeginPlay();

    UPROPERTY(ReplicatedUsing = OnRep_Health)
    float RepHealth;

private:
    void RecalcStats();
};
`;

test("scanCppImplSymbols finds qualified definitions and rejects call sites", () => {
  const path = "E:/Proj/Source/NFGAME/Private/ANFCharacter.cpp";
  const entries = scanCppImplSymbols(CPP_SAMPLE, path);

  const names = entries.map((e) => `${e.container}::${e.name}`);
  assert.ok(names.includes("ANFCharacter::ANFCharacter"), names.join(", "));
  assert.ok(names.includes("ANFCharacter::BeginPlay"));
  assert.ok(names.includes("ANFCharacter::TakeDamage"));
  assert.ok(names.includes("ANFCharacter::Tick"));
  assert.ok(names.includes("ANFCharacter::LongSignature"));

  // Call sites must NOT be indexed.
  assert.ok(!names.includes("Super::BeginPlay"));
  assert.ok(!names.includes("UNFUtils::CheckThing"));
  assert.ok(!names.includes("UNFHealthComponent::StaticClass"));
  assert.ok(!names.includes("ANFUtils::Helper"));
  // Statement call with no body on the line.
  assert.ok(!names.includes("UNFHealthComponent::StaticApply"));

  const ctor = entries.find((e) => e.name === "ANFCharacter")!;
  assert.equal(ctor.kind, "function");
  assert.equal(ctor.isImpl, true);
  assert.equal(ctor.returnType, undefined);
  assert.ok((ctor.params ?? "").includes("FObjectInitializer"));

  const take = entries.find((e) => e.name === "TakeDamage")!;
  assert.equal(take.container, "ANFCharacter");
  assert.equal(take.returnType, "float");
  assert.ok((take.params ?? "").startsWith("float Damage"));

  const long = entries.find((e) => e.name === "LongSignature")!;
  assert.equal(long.params, "int32 ParamA, float ParamB");

  // Definition lines are 1-based and point at the signature start.
  assert.ok(CPP_SAMPLE.split(/\r?\n/)[entries.find((e) => e.name === "BeginPlay")!.line - 1].includes("ANFCharacter::BeginPlay"));
});

test("scanCppDeclSymbols resolves class containers, functions and fields", () => {
  const path = "E:/Proj/Source/NFGAME/Public/ANFCharacter.h";
  const entries = scanCppDeclSymbols(HEADER_SAMPLE, path);

  const cls = entries.find((e) => e.name === "ANFCharacter" && e.kind === "class");
  assert.ok(cls, "class symbol present");

  const take = entries.find((e) => e.name === "TakeDamage");
  assert.ok(take, "TakeDamage decl present");
  assert.equal(take!.kind, "function");
  assert.equal(take!.container, "ANFCharacter");
  assert.equal(take!.returnType, "float");
  assert.equal(take!.params, "float Damage");
  assert.equal(take!.isImpl, undefined);

  const health = entries.find((e) => e.name === "Health");
  assert.ok(health, "UPROPERTY field indexed");
  assert.equal(health!.kind, "variable");
  assert.equal(health!.container, "ANFCharacter");
  assert.equal(health!.returnType, "float");

  for (const name of ["RecalcStats", "BeginPlay", "RepHealth"]) {
    assert.ok(entries.some((e) => e.name === name), `missing ${name}`);
  }
});

test("scanCppIndexSymbols merges impl and decl without double-counting a line", () => {
  const header = "E:/Proj/Source/NFGAME/Public/ANFCharacter.h";
  const source = "E:/Proj/Source/NFGAME/Private/ANFCharacter.cpp";
  const headerEntries = scanCppIndexSymbols(HEADER_SAMPLE, header);
  const sourceEntries = scanCppIndexSymbols(CPP_SAMPLE, source);

  const key = (e: { name: string; line: number }) => `${e.name}@${e.line}`;
  const headerKeys = headerEntries.map(key);
  assert.equal(new Set(headerKeys).size, headerKeys.length, "header entries unique");

  // Sources: qualified impl entries for methods + no duplicate decl rows on those lines.
  const impls = sourceEntries.filter((e) => e.isImpl);
  assert.ok(impls.length >= 5);
  for (const impl of impls) {
    const dup = sourceEntries.filter(
      (e) => e.line === impl.line && e.name === impl.name,
    );
    assert.equal(dup.length, 1, `duplicated ${impl.name}@${impl.line}`);
  }
});

test("scanCppDeclSymbols keeps constructor initializers out of the type name", () => {
  // The classic F12 bug: `FVector X = FVector(0.f);` indexed the RHS
  // constructor call as a member function literally named "FVector".
  const path = "E:/Proj/Source/NFGAME/Public/NFZipline.h";
  const text = `#pragma once

#include "CoreMinimal.h"

UCLASS()
class ANFZipline : public AActor
{
    GENERATED_BODY()

public:
    FVector RopeTopOperator = FVector(0.f, 0.f, 500.f);
    FVector2D PitchRange = FVector2D(-20.f, -80.f);
    TTuple<FVector, int, FName> LastPreAim = {FVector(FLT_MAX), 0, NAME_None};
    FColor SafeColor = {FColor(1, 2, 3)};
    void SetDefaults(float V = 0.f, FVector P = FVector(1.f));
    FVector GetTop() const;
    float PlainField = 42.f;
};
`;
  const entries = scanCppDeclSymbols(text, path);

  // No entry may be *named* after the initializer's type.
  for (const dirty of ["FVector", "FVector2D", "FColor"]) {
    assert.ok(
      !entries.some((e) => e.name === dirty),
      `dirty entry named ${dirty}`,
    );
  }

  // The declared members are indexed as variables with correct types.
  const rope = entries.find((e) => e.name === "RopeTopOperator");
  assert.ok(rope, "RopeTopOperator indexed");
  assert.equal(rope!.kind, "variable");
  assert.equal(rope!.container, "ANFZipline");
  assert.equal(rope!.returnType, "FVector");
  assert.ok(entries.some((e) => e.name === "PitchRange"), "PitchRange indexed");
  assert.ok(entries.some((e) => e.name === "PlainField"), "PlainField indexed");
  assert.ok(entries.some((e) => e.name === "LastPreAim"), "LastPreAim indexed");

  // Real methods still work, including one with a ctor-default parameter.
  const setDefaults = entries.find((e) => e.name === "SetDefaults");
  assert.ok(setDefaults, "SetDefaults indexed as a real function");
  assert.equal(setDefaults!.kind, "function");
  assert.ok(entries.some((e) => e.name === "GetTop"), "GetTop indexed");
});

test("buildCppFileList filters to C++ and puts headers first", () => {
  const list = buildCppFileList([
    "E:/Proj/Source/Game.cpp",
    "E:/Proj/Source/A.h",
    "E:/Proj/Content/foo.uasset",
    "E:/Proj/Source/B.cpp",
    "E:/Proj/Source/B.h",
    "E:/Proj/Source/B.h", // dup
    "E:/Proj/package.json",
  ]);
  assert.deepEqual(list, [
    "E:/Proj/Source/A.h",
    "E:/Proj/Source/B.h",
    "E:/Proj/Source/B.cpp",
    "E:/Proj/Source/Game.cpp",
  ]);
});

test("isCppIndexablePath accepts the C++ family only", () => {
  assert.ok(isCppIndexablePath("a/B.h"));
  assert.ok(isCppIndexablePath("a/B.hpp"));
  assert.ok(isCppIndexablePath("a\\B.inl"));
  assert.ok(isCppIndexablePath("a/B.cpp"));
  assert.ok(isCppIndexablePath("a/B.cc"));
  assert.ok(!isCppIndexablePath("a/B.cs"));
  assert.ok(!isCppIndexablePath("a/B.generated.h.cs"));
  assert.ok(!isCppIndexablePath("a/B.uasset"));
});

test("isCppSiblingFile pairs headers and sources both directions", () => {
  const pub = "E:/Proj/Source/Game/Public/ANFCharacter.h";
  const priv = "E:/Proj/Source/Game/Private/ANFCharacter.cpp";
  assert.ok(isCppSiblingFile(pub, priv));
  assert.ok(isCppSiblingFile(priv, pub));
  assert.ok(isCppSiblingFile("src/a.h", "src/a.cpp"));
  assert.ok(isCppSiblingFile("src\\a.cpp", "src/a.h"));
  assert.ok(!isCppSiblingFile("src/a.h", "src/b.cpp"));
  assert.ok(!isCppSiblingFile("src/a.h", "other/a.cpp"));
  // .gen.cpp must not pair with the class header.
  assert.ok(!isCppSiblingFile(pub, "E:/Proj/Source/Game/Private/ANFCharacter.gen.cpp"));
});

function makeIndex(files: Map<string, string>) {
  const yields: number[] = [];
  const index = new CppWorkspaceIndex({
    listCppFiles: async () => [...files.keys()],
    readTextFile: async (path) => files.get(path) ?? null,
    yieldToUi: async () => {
      yields.push(Date.now());
    },
  });
  return { index, yields };
}

const HEADER = "E:/Proj/Source/Public/ANFCharacter.h";
const SOURCE = "E:/Proj/Source/Private/ANFCharacter.cpp";

test("CppWorkspaceIndex builds lazily and looks up case-insensitively", async () => {
  const { index, yields } = makeIndex(
    new Map([
      [HEADER, HEADER_SAMPLE],
      [SOURCE, CPP_SAMPLE],
    ]),
  );
  assert.equal(index.getStats().state, "idle");
  await index.ensure("E:\\Proj");
  const stats = index.getStats();
  assert.equal(stats.state, "ready");
  assert.equal(stats.root, "E:/Proj");
  assert.equal(stats.fileCount, 2);
  assert.ok(stats.symbolCount >= 8, `symbols: ${stats.symbolCount}`);

  const cls = index.getEntries("anfcharacter").find((e) => e.kind === "class");
  assert.ok(cls, "class lookup by lower-case name");
  assert.equal(cls!.path, HEADER);

  const impl = index
    .getEntries("TakeDamage")
    .find((e) => e.isImpl);
  assert.ok(impl, "impl entry indexed");
  assert.equal(impl!.path, SOURCE);
  const decl = index.getEntries("TakeDamage").find((e) => !e.isImpl);
  assert.ok(decl, "decl entry indexed");

  // Re-ensure on the same root is a no-op (no extra yields).
  const yieldsBefore = yields.length;
  await index.ensure("E:/Proj");
  assert.equal(yields.length, yieldsBefore);
});

test("CppWorkspaceIndex upsertFile keeps live-model text authoritative", async () => {
  const { index } = makeIndex(new Map([[HEADER, HEADER_SAMPLE]]));
  await index.ensure("E:/Proj");
  assert.ok(index.getEntries("RecalcStats").length > 0);
  assert.equal(index.getEntries("BrandNewFunc").length, 0);

  // Editor buffer: RecalcStats renamed to BrandNewFunc, same file.
  const edited = HEADER_SAMPLE.replace("void RecalcStats();", "void BrandNewFunc();");
  index.upsertFile(HEADER, edited);
  assert.equal(index.getEntries("RecalcStats").length, 0);
  assert.ok(index.getEntries("BrandNewFunc").length > 0);
  assert.ok(index.getEntries("ANFCharacter").some((e) => e.kind === "class"));

  // Symbol count stays consistent after replacement.
  const before = index.getStats().symbolCount;
  index.upsertFile(HEADER, edited);
  assert.equal(index.getStats().symbolCount, before);
});

test("CppWorkspaceIndex rebuilds when the workspace root changes", async () => {
  const filesA = new Map([[HEADER, HEADER_SAMPLE]]);
  const filesB = new Map<string, string>([
    [
      "E:/Other/Source/Public/BOther.h",
      `#pragma once

class BOther
{
public:
    void OtherThing();
};
`,
    ],
  ]);
  let current = filesA;
  const index = new CppWorkspaceIndex({
    listCppFiles: async () => [...current.keys()],
    readTextFile: async (path) => current.get(path) ?? null,
  });
  await index.ensure("E:/Proj");
  assert.ok(index.getEntries("ANFCharacter").length > 0);

  current = filesB;
  await index.ensure("E:/Other");
  assert.equal(index.getEntries("ANFCharacter").length, 0);
  assert.ok(index.getEntries("OtherThing").length > 0);
  assert.equal(index.getStats().root, "E:/Other");
});

test("full symbol scan lifts the per-file cap used by outline", () => {
  const lines = ["#pragma once", "class Bucket {", "public:"];
  for (let i = 0; i < 450; i++) lines.push(`    void Fn${i}();`);
  lines.push("};");
  const text = lines.join("\n");
  const path = "E:/Proj/Bucket.h";
  const capped = scanCppIndexSymbols(text, path);
  const full = scanCppIndexSymbols(text, path, {
    maxSymbols: Number.POSITIVE_INFINITY,
  });
  assert.ok(capped.length <= 400, `capped ${capped.length}`);
  assert.ok(full.length > 400, `full ${full.length}`);
  assert.ok(full.some((entry) => entry.name === "Fn449"));
  assert.ok(!capped.some((entry) => entry.name === "Fn449"));
});

test("coveringSymbolScanRoot mirrors the walker's skip rules", () => {
  const ws = "E:/Proj";
  const engine = "D:/UE_5.4/Engine/Source";
  const roots = { workspaceRoot: ws, extraRoots: [engine] };

  // Workspace coverage, case-insensitive on win32.
  assert.equal(coveringSymbolScanRoot("e:/proj/source/game", roots, true), ws);
  assert.equal(coveringSymbolScanRoot(`${ws}\\Source\\Game`, roots, true), ws);
  assert.equal(coveringSymbolScanRoot(ws, roots, true), ws);

  // Engine-style skipped subtree inside the workspace is NOT covered —
  // the walker never enters a directory named Engine/Intermediate/… .
  assert.equal(
    coveringSymbolScanRoot(`${ws}/Engine/Source/Runtime`, roots, true),
    null,
  );
  assert.equal(coveringSymbolScanRoot(`${ws}/Intermediate/x`, roots, true), null);

  // The engine extra root covers itself and its subdirs (root name is
  // never checked), but skipped children below it stay uncovered.
  assert.equal(coveringSymbolScanRoot(engine, roots, true), engine);
  assert.equal(
    coveringSymbolScanRoot(`${engine}/Runtime/Core/Public`, roots, true),
    engine,
  );
  assert.equal(
    coveringSymbolScanRoot("D:/UE_5.4/Engine/Source/Intermediate/x", roots, true),
    null,
  );

  // Outside every root, or above one: uncovered.
  assert.equal(coveringSymbolScanRoot("D:/UE_5.4/Engine", roots, true), null);
  assert.equal(coveringSymbolScanRoot("D:/Other/Source", roots, true), null);

  // Case-sensitive platforms do not fold drive letters.
  assert.equal(coveringSymbolScanRoot("e:/proj/source", roots, false), null);

  assert.equal(isSkippedSymbolDir(".git"), true);
  assert.equal(isSkippedSymbolDir("Intermediate"), true);
  assert.equal(isSkippedSymbolDir("Source"), false);
});

// ------------------------------------------------- multi-language dispatch

test("isSymbolIndexablePath covers C++, TS/JS, and CSS", () => {
  assert.ok(isSymbolIndexablePath("a/B.h"));
  assert.ok(isSymbolIndexablePath("a/B.cpp"));
  assert.ok(isSymbolIndexablePath("src/index.ts"));
  assert.ok(isSymbolIndexablePath("src/App.tsx"));
  assert.ok(isSymbolIndexablePath("src/x.mjs"));
  assert.ok(isSymbolIndexablePath("src/styles.css"));
  assert.ok(!isSymbolIndexablePath("a/B.cs"));
  assert.ok(!isSymbolIndexablePath("src/x.scss"));
  assert.ok(!isSymbolIndexablePath("README.md"));
});

test("scanIndexSymbols maps TS declarations with containers and params", () => {
  const ts = `export class TurnHost {
  private worker: Worker | null = null;

  start(root: string): void {
    return;
  }
}

export function createTurnHost(opts: Options): TurnHost {
  return new TurnHost();
}

export const MAX_FILES = 4000;
`;
  const entries = scanIndexSymbols(ts, "src/agent/turnHost.ts");
  const byName = new Map(entries.map((e) => [`${e.kind} ${e.name}`, e]));

  const cls = byName.get("class TurnHost");
  assert.ok(cls);
  assert.equal(cls?.line, 1);
  assert.equal(cls?.container, undefined);

  const field = byName.get("variable worker");
  assert.ok(field);
  assert.equal(field?.container, "TurnHost");

  const method = byName.get("function start");
  assert.ok(method);
  assert.equal(method?.container, "TurnHost");
  assert.equal(method?.params, "root: string");

  const fn = byName.get("function createTurnHost");
  assert.ok(fn);
  assert.equal(fn?.params, "opts: Options");
  assert.equal(fn?.returnType, "TurnHost");

  const constant = byName.get("variable MAX_FILES");
  assert.ok(constant);
  assert.equal(constant?.line, 13);
});

test("scanIndexSymbols CSS: selectors, custom properties, keyframes", () => {
  const css = `/* theme tokens */
:root {
  --accent: #58a6ff;
  --accent-rgb: 88, 166, 255;
}

.toolbar {
  color: var(--accent);
}

@media (min-width: 600px) {
  .toolbar { padding: 8px; }
}

@keyframes pulse {
  0% { opacity: 1; }
}

div > .nested, .row /* trailing */ {
  margin: 0;
}

:root { --single-line: 1px; }
`;
  const entries = scanIndexSymbols(css, "src/devmode.css");
  const names = entries.map((e) => e.name);

  assert.ok(names.includes(":root"));
  assert.ok(names.includes("--accent"));
  assert.ok(names.includes("--accent-rgb"));
  assert.ok(names.includes("--single-line")); // one-line :root block
  assert.ok(names.includes(".toolbar")); // depth-0 only: the @media copy is skipped
  assert.equal(
    entries.filter((e) => e.name === ".toolbar").length,
    1,
    "nested @media copy must not duplicate",
  );
  assert.ok(names.includes("pulse")); // @keyframes name, kind type
  assert.ok(names.includes("div > .nested, .row")); // comment stripped

  const accent = entries.find((e) => e.name === "--accent");
  assert.equal(accent?.kind, "variable");
  assert.equal(accent?.line, 3);

  const kf = entries.find((e) => e.name === "pulse");
  assert.equal(kf?.kind, "type");

  const toolbar = entries.find((e) => e.name === ".toolbar");
  assert.equal(toolbar?.kind, "type");
  assert.equal(toolbar?.line, 7);
});

test("scanIndexSymbols dispatches by extension and clips long CSS names", () => {
  assert.equal(scanIndexSymbols("x", "README.md").length, 0);
  // C++ path still routes through the C++ scanners.
  const cppEntries = scanIndexSymbols(
    "void Foo::Bar() {}\n",
    "src/Foo.cpp",
  );
  assert.equal(cppEntries.length, 1);
  assert.equal(cppEntries[0]?.name, "Bar");
  assert.equal(cppEntries[0]?.container, "Foo");
  assert.equal(cppEntries[0]?.isImpl, true);

  const long = `.${"a".repeat(200)} { color: red; }`;
  const clipped = scanIndexSymbols(long, "a.css")[0]!;
  assert.ok(clipped.name.length <= 121);
  assert.ok(clipped.name.endsWith("…"));
});
