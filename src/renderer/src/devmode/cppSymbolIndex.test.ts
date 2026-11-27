import assert from "node:assert/strict";
import { test } from "node:test";

import {
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

  assert.ok(!names.includes("Super::BeginPlay"));
  assert.ok(!names.includes("UNFUtils::CheckThing"));
  assert.ok(!names.includes("UNFHealthComponent::StaticClass"));
  assert.ok(!names.includes("ANFUtils::Helper"));
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

  for (const dirty of ["FVector", "FVector2D", "FColor"]) {
    assert.ok(
      !entries.some((e) => e.name === dirty),
      `dirty entry named ${dirty}`,
    );
  }

  const rope = entries.find((e) => e.name === "RopeTopOperator");
  assert.ok(rope, "RopeTopOperator indexed");
  assert.equal(rope!.kind, "variable");
  assert.equal(rope!.container, "ANFZipline");
  assert.equal(rope!.returnType, "FVector");
  assert.ok(entries.some((e) => e.name === "PitchRange"), "PitchRange indexed");
  assert.ok(entries.some((e) => e.name === "PlainField"), "PlainField indexed");
  assert.ok(entries.some((e) => e.name === "LastPreAim"), "LastPreAim indexed");

  const setDefaults = entries.find((e) => e.name === "SetDefaults");
  assert.ok(setDefaults, "SetDefaults indexed as a real function");
  assert.equal(setDefaults!.kind, "function");
  assert.ok(entries.some((e) => e.name === "GetTop"), "GetTop indexed");
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
  assert.ok(!isCppSiblingFile(pub, "E:/Proj/Source/Game/Private/ANFCharacter.gen.cpp"));
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

  assert.equal(coveringSymbolScanRoot("e:/proj/source/game", roots, true), ws);
  assert.equal(coveringSymbolScanRoot(`${ws}\\Source\\Game`, roots, true), ws);
  assert.equal(coveringSymbolScanRoot(ws, roots, true), ws);

  assert.equal(
    coveringSymbolScanRoot(`${ws}/Engine/Source/Runtime`, roots, true),
    null,
  );
  assert.equal(coveringSymbolScanRoot(`${ws}/Intermediate/x`, roots, true), null);

  assert.equal(coveringSymbolScanRoot(engine, roots, true), engine);
  assert.equal(
    coveringSymbolScanRoot(`${engine}/Runtime/Core/Public`, roots, true),
    engine,
  );
  assert.equal(
    coveringSymbolScanRoot("D:/UE_5.4/Engine/Source/Intermediate/x", roots, true),
    null,
  );

  assert.equal(coveringSymbolScanRoot("D:/UE_5.4/Engine", roots, true), null);
  assert.equal(coveringSymbolScanRoot("D:/Other/Source", roots, true), null);

  assert.equal(coveringSymbolScanRoot("e:/proj/source", roots, false), null);

  assert.equal(isSkippedSymbolDir(".git"), true);
  assert.equal(isSkippedSymbolDir("Intermediate"), true);
  assert.equal(isSkippedSymbolDir("Source"), false);
});


test("isSymbolIndexablePath covers C++, TS/JS, CSS and outline languages", () => {
  assert.ok(isSymbolIndexablePath("a/B.h"));
  assert.ok(isSymbolIndexablePath("a/B.cpp"));
  assert.ok(isSymbolIndexablePath("src/index.ts"));
  assert.ok(isSymbolIndexablePath("src/App.tsx"));
  assert.ok(isSymbolIndexablePath("src/x.mjs"));
  assert.ok(isSymbolIndexablePath("src/styles.css"));
  assert.ok(isSymbolIndexablePath("a/B.cs"));
  assert.ok(isSymbolIndexablePath("tools/scan.py"));
  assert.ok(isSymbolIndexablePath("crate\\lib.rs"));
  assert.ok(!isSymbolIndexablePath("src/x.scss"));
  assert.ok(!isSymbolIndexablePath("README.md"));
  assert.ok(!isSymbolIndexablePath("a/B.uasset"));
});

test("scanIndexSymbols indexes outline languages with containers", () => {
  const py = scanIndexSymbols(
    "class Scanner:\n    def run_scan(self, root: str) -> None:\n        pass\n",
    "tools/scan.py",
  );
  assert.deepEqual(
    py.map((e) => `${e.kind}:${e.container ?? ""}:${e.name}`),
    ["class::Scanner", "function:Scanner:run_scan"],
  );
  const rs = scanIndexSymbols(
    "pub async fn fetch_all(&self) -> Vec<Entry> {\n}\n",
    "crate/lib.rs",
  );
  assert.deepEqual(rs.map((e) => e.name), ["fetch_all"]);
  const cs = scanIndexSymbols(
    "public class PlayerController\n{\n    public void Jump()\n    {\n    }\n}\n",
    "Assets/PlayerController.cs",
  );
  assert.ok(cs.some((e) => e.kind === "class" && e.name === "PlayerController"));
  assert.ok(cs.every((e) => e.path === "Assets/PlayerController.cs"));
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
  assert.ok(names.includes("--single-line"));
  assert.ok(names.includes(".toolbar"));
  assert.equal(
    entries.filter((e) => e.name === ".toolbar").length,
    1,
    "nested @media copy must not duplicate",
  );
  assert.ok(names.includes("pulse"));
  assert.ok(names.includes("div > .nested, .row"));

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

test("elaborated type specifiers in signatures are not type declarations", async () => {
  const { resolveEnclosingContainer } = await import("./cppContainerContext.js");
  const { parseCppTypeHead } = await import("./cppHeaderOutline.js");
  const header = `#pragma once
class IEditableSkeleton
{
public:
	/** Set the additional skeletal meshes */
	virtual void SetAdditionalPreviewSkeletalMeshes(class UDataAsset* InPreviewCollectionAsset) = 0;
	virtual void SetPreviewMesh(class USkeletalMesh* InSkeletalMesh,
		struct FPreviewOptions Options) = 0;
	class UAnimSequence* LastSequence;
	virtual void RenameRetargetSource(const FName InOldName) = 0;
};

UCLASS(abstract, MinimalAPI, Meta = (LoadBehavior = "LazyOnDemand"))
class UDataAsset : public UObject
{
	GENERATED_UCLASS_BODY()
};
`;
  const entries = scanCppIndexSymbols(header, "E:/UE/Engine/Source/Editor/IEditableSkeleton.h");
  const types = entries.filter((e) => e.kind === "class" || e.kind === "struct");
  assert.deepEqual(types.map((e) => `${e.name}@${e.line}`), ["IEditableSkeleton@2", "UDataAsset@14"]);
  assert.equal(types.find((e) => e.name === "UDataAsset")?.container, undefined);
  const methods = entries.filter((e) => e.kind === "function").map((e) => `${e.container}::${e.name}`);
  assert.ok(methods.includes("IEditableSkeleton::SetAdditionalPreviewSkeletalMeshes"), methods.join(", "));
  assert.ok(methods.includes("IEditableSkeleton::SetPreviewMesh"));
  assert.ok(methods.includes("IEditableSkeleton::RenameRetargetSource"));
  assert.ok(entries.some((e) => e.kind === "variable" && e.name === "LastSequence"));

  for (const [text, name] of [
    ["class NF_API ANFCharacter : public ACharacter, public IAbilityInterface", "ANFCharacter"],
    ["UCLASS(BlueprintType) class UMyAsset : public UDataAsset", "UMyAsset"],
    ["struct FFoo", "FFoo"],
    ["struct FFoo final : public FBar {", "FFoo"],
    ["enum class EThing : uint8", "EThing"],
    ["template<typename T> class TBox", "TBox"],
    ["template<> struct TStructOpsTypeTraits<FFoo> : public TStructOpsTypeTraitsBase2<FFoo>", "TStructOpsTypeTraits"],
  ] as const) {
    assert.equal(parseCppTypeHead(text)?.name, name, text);
  }
  for (const text of [
    "virtual void Set(class UDataAsset* InAsset) = 0;",
    "class UAnimSequence* LastSequence;",
    "friend class FOther;",
    "void Free(struct FOptions Options)",
  ]) {
    assert.equal(parseCppTypeHead(text), null, text);
  }

  const source = `void Free(class UDataAsset* Asset)
{
    Asset->Touch();
}
`;
  assert.equal(resolveEnclosingContainer(source, 3).container, null);
});
