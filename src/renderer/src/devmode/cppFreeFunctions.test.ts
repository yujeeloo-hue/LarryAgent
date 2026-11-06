import assert from "node:assert/strict";
import { test } from "node:test";

import {
  matchFreeFunction,
  scanCppFreeFunctions,
  scanCppImplSymbols,
  scanCppIndexSymbols,
} from "./cppSymbolIndex.js";

const SOURCE = `#include "NFUtils.h"
#define NF_LOG(X) \\
    UE_LOG(LogTemp, Log, X)

DEFINE_LOG_CATEGORY(LogNF)
static TAutoConsoleVariable<int32> CVarNFDebug(TEXT("nf.Debug"), 0, TEXT("Debug"));
FVector GOrigin(0.f, 0.f, 0.f);

static float ComputeDamage(float Base, int32 Combo)
{
    float Scale = ClampScale(Base);
    return Base * Combo;
}

namespace NF::Math
{
    FORCEINLINE int32 Square(int32 X) { return X * X; }

    template <typename T>
    T Lerp3(const T& A, const T& B, float Alpha);
}

extern "C" {
    NFGAME_API void NF_Init(void);
}

void ANFCharacter::Attack(float Damage)
{
    Helper(Damage);
}

TArray<FString>
CollectNames(const UWorld* World,
             bool bIncludeHidden)
{
    return {};
}

int main(int argc, char** argv) { return 0; }
`;

test("file-scope free functions: prototypes, definitions, namespaces, extern C", () => {
  const hits = scanCppFreeFunctions(SOURCE, "Source/NFUtils.cpp");
  assert.deepEqual(
    hits.map((h) => h.name),
    ["ComputeDamage", "Square", "Lerp3", "NF_Init", "CollectNames", "main"],
  );
  const damage = hits.find((h) => h.name === "ComputeDamage")!;
  assert.equal(damage.params, "float Base, int32 Combo");
  assert.equal(damage.returnType, "float");
  assert.equal(damage.container, undefined);
  assert.equal(hits.find((h) => h.name === "Square")!.returnType, "int32");
  assert.equal(hits.find((h) => h.name === "NF_Init")!.returnType, "void");
  const collect = hits.find((h) => h.name === "CollectNames")!;
  assert.equal(collect.params, "const UWorld* World, bool bIncludeHidden");
  assert.equal(collect.returnType, "TArray<FString>");
});

test("variable initializers, macros, calls and qualified defs are not free functions", () => {
  assert.equal(matchFreeFunction("FVector GOrigin(0.f, 0.f, 0.f);"), null);
  assert.equal(matchFreeFunction('static const FName NAME_Foo(TEXT("Foo"));'), null);
  assert.equal(matchFreeFunction("DEFINE_LOG_CATEGORY(LogNF);"), null);
  assert.equal(matchFreeFunction("UE_LOG(LogTemp, Log, Msg);"), null);
  assert.equal(matchFreeFunction("auto Fn = [](int A) { return A; };"), null);
  assert.equal(matchFreeFunction("void ANFCharacter::Attack(float D) {"), null);
  assert.equal(matchFreeFunction("typedef void (*FCallback)(int);"), null);
  assert.equal(matchFreeFunction("if (bReady) {"), null);
  assert.deepEqual(matchFreeFunction("bool IsReady();"), { name: "IsReady", params: "", returnType: "bool" });
});

test("class bodies stay members; one-line types do not leak their container", () => {
  const header = `#pragma once
class FTag {};
class NFGAME_API UNFLibrary : public UObject
{
public:
    static void LibFn(int32 A);
};

void FreeAfterTag(int32 Count);
`;
  const entries = scanCppIndexSymbols(header, "Source/NFLibrary.h");
  const free = entries.find((e) => e.name === "FreeAfterTag");
  assert.ok(free, "free function after a one-line class is indexed");
  assert.equal(free!.container, undefined);
  const lib = entries.find((e) => e.name === "LibFn");
  assert.equal(lib?.container, "UNFLibrary");
  assert.equal(entries.filter((e) => e.name === "LibFn").length, 1);
});

test("Slate declarative chains are not Class::Method definitions", () => {
  const slate = `void SNFPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot()
        .AutoHeight()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
        ]
    ];
    UNFSubsystem::Get()->Refresh();
}
`;
  const impls = scanCppImplSymbols(slate, "Source/SNFPanel.cpp");
  assert.deepEqual(impls.map((e) => `${e.container}::${e.name}`), ["SNFPanel::Construct"]);
});

test("source index combines impls and free functions without duplicates", () => {
  const entries = scanCppIndexSymbols(SOURCE, "Source/NFUtils.cpp");
  const attack = entries.filter((e) => e.name === "Attack");
  assert.equal(attack.length, 1);
  assert.equal(attack[0]!.isImpl, true);
  assert.ok(entries.some((e) => e.name === "ComputeDamage" && !e.container));
  assert.equal(entries.some((e) => e.name === "Helper" || e.name === "ClampScale"), false);
});
