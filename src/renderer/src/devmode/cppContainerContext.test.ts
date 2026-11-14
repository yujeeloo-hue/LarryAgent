/**
 * L2 enclosing-container resolution (cppContainerContext.ts).
 *
 * The cases below are the ones `qualifiedContainerBefore` cannot answer:
 * bare calls in a method body, header member declarations, and carets that
 * sit on an implementation signature without a spelled-out qualifier.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  braceDeltaOf,
  classifyBlockHead,
  resolveEnclosingContainer,
  stripCommentsForScan,
} from "./cppContainerContext.js";

/** 1-based line number of the first line containing `needle`. */
function lineOf(text: string, needle: string): number {
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `fixture missing: ${needle}`);
  return index + 1;
}

const SOURCE = `#include "ANFCharacter.h"

void ANFCharacter::BeginPlay()
{
    Super::BeginPlay();
    RefreshHealth();

    if (Health <= 0.f)
    {
        HandleDeath();
    }

    for (int32 Index = 0; Index < 4; ++Index)
    {
        TickOnce(Index);
    }
}

float ANFCharacter::TakeDamage(float Damage)
{
    return Damage;
}

void BEnemy::BeginPlay()
{
    Patrol();
}

static void FreeHelper()
{
    DoThing();
}
`;

test("resolves the enclosing class for bare calls in a .cpp body", () => {
  // Plain call, one level deep inside the method body.
  const bare = resolveEnclosingContainer(SOURCE, lineOf(SOURCE, "RefreshHealth();"));
  assert.equal(bare.container, "ANFCharacter");
  assert.equal(bare.source, "impl-signature");
  assert.equal(bare.containerChain, "ANFCharacter::");
  assert.equal(bare.line, lineOf(SOURCE, "void ANFCharacter::BeginPlay()"));

  // Nested control flow must hop outwards past `if` / `for` heads.
  assert.equal(
    resolveEnclosingContainer(SOURCE, lineOf(SOURCE, "HandleDeath();")).container,
    "ANFCharacter",
  );
  assert.equal(
    resolveEnclosingContainer(SOURCE, lineOf(SOURCE, "TickOnce(Index);")).container,
    "ANFCharacter",
  );

  // A second method in the same file resolves independently…
  assert.equal(
    resolveEnclosingContainer(SOURCE, lineOf(SOURCE, "return Damage;")).container,
    "ANFCharacter",
  );
  // …and so does a different class living in the same translation unit.
  assert.equal(
    resolveEnclosingContainer(SOURCE, lineOf(SOURCE, "Patrol();")).container,
    "BEnemy",
  );

  // Free function: no container, not a wrong one.
  assert.equal(
    resolveEnclosingContainer(SOURCE, lineOf(SOURCE, "DoThing();")).container,
    null,
  );
  // File scope between definitions.
  assert.equal(resolveEnclosingContainer(SOURCE, 2).container, null);
});

test("the caret's own line resolves when it is an impl signature", () => {
  const ctx = resolveEnclosingContainer(
    SOURCE,
    lineOf(SOURCE, "float ANFCharacter::TakeDamage(float Damage)"),
  );
  assert.equal(ctx.container, "ANFCharacter");
  assert.equal(ctx.source, "impl-signature");
});

const HEADER = `#pragma once

UCLASS()
class ANFCharacter : public AActor
{
    GENERATED_BODY()

public:
    ANFCharacter();

    virtual void BeginPlay() override;

    UPROPERTY(EditAnywhere)
    float Health = 100.f;

    struct FInner
    {
        void Reset();
    };
};

USTRUCT()
struct FNFStats
{
    GENERATED_BODY()

    float Armor = 0.f;
};
`;

test("resolves the enclosing class for header member declarations", () => {
  const member = resolveEnclosingContainer(
    HEADER,
    lineOf(HEADER, "virtual void BeginPlay() override;"),
  );
  assert.equal(member.container, "ANFCharacter");
  assert.equal(member.source, "type-body");
  assert.equal(member.line, lineOf(HEADER, "class ANFCharacter : public AActor"));

  // UPROPERTY field, and the specifier line above it.
  assert.equal(
    resolveEnclosingContainer(HEADER, lineOf(HEADER, "float Health = 100.f;")).container,
    "ANFCharacter",
  );
  assert.equal(
    resolveEnclosingContainer(HEADER, lineOf(HEADER, "UPROPERTY(EditAnywhere)")).container,
    "ANFCharacter",
  );

  // Nested type wins over the outer class (innermost enclosing block).
  assert.equal(
    resolveEnclosingContainer(HEADER, lineOf(HEADER, "void Reset();")).container,
    "FInner",
  );

  // USTRUCT body.
  assert.equal(
    resolveEnclosingContainer(HEADER, lineOf(HEADER, "float Armor = 0.f;")).container,
    "FNFStats",
  );

  // The class head itself: the caret may be on the base class — claiming
  // ANFCharacter here would mis-rank a jump to `AActor`.
  assert.equal(
    resolveEnclosingContainer(HEADER, lineOf(HEADER, "class ANFCharacter : public AActor"))
      .container,
    null,
  );
  // Outside any type.
  assert.equal(resolveEnclosingContainer(HEADER, 1).container, null);
});

test("namespaces and lambdas hop outwards to the owning class", () => {
  const text = `namespace NF
{
    void FShim::Apply()
    {
        auto Fn = [this](int32 N)
        {
            Consume(N);
        };
        Fn(1);
    }

    void Loose()
    {
        Helper();
    }
}
`;
  // Lambda body → enclosing method's class.
  assert.equal(
    resolveEnclosingContainer(text, lineOf(text, "Consume(N);")).container,
    "FShim",
  );
  assert.equal(
    resolveEnclosingContainer(text, lineOf(text, "Fn(1);")).container,
    "FShim",
  );
  // A free function inside a namespace has no class container.
  assert.equal(
    resolveEnclosingContainer(text, lineOf(text, "Helper();")).container,
    null,
  );
});

test("UE style: reflection macros and multi-line signatures", () => {
  const text = `void ANFCharacter::OnHit(
    UPrimitiveComponent* HitComp,
    AActor* Other)
{
    Resolve(Other);
}
`;
  const ctx = resolveEnclosingContainer(text, lineOf(text, "Resolve(Other);"));
  assert.equal(ctx.container, "ANFCharacter");
  assert.equal(ctx.line, 1);

  // Template method head.
  const templated = `template <typename T>
void TRing<T>::Push(const T& Item)
{
    Store(Item);
}
`;
  assert.equal(
    resolveEnclosingContainer(templated, lineOf(templated, "Store(Item);")).container,
    "TRing",
  );
});

test("commented and preprocessor braces do not skew the walk", () => {
  const text = `void ANFCharacter::BeginPlay()
{
    // if (Old) { LegacyCall(); }
    /* stray } brace in a comment */
#if WITH_EDITOR
    EditorOnly();
#endif
    RefreshHealth();
}
`;
  assert.equal(
    resolveEnclosingContainer(text, lineOf(text, "RefreshHealth();")).container,
    "ANFCharacter",
  );
  assert.equal(
    resolveEnclosingContainer(text, lineOf(text, "EditorOnly();")).container,
    "ANFCharacter",
  );
});

test("string literals holding braces are ignored", () => {
  assert.equal(braceDeltaOf(`FString S = TEXT("{{{");`), 0);
  assert.equal(braceDeltaOf(`if (C == '{') {`), 1);
  assert.equal(braceDeltaOf("void F() {"), 1);
  assert.equal(braceDeltaOf("}"), -1);

  const text = `void ANFCharacter::Log()
{
    UE_LOG(LogNF, Log, TEXT("brace { here"));
    Emit();
}
`;
  assert.equal(
    resolveEnclosingContainer(text, lineOf(text, "Emit();")).container,
    "ANFCharacter",
  );
});

test("stripCommentsForScan removes tails, spans and directives", () => {
  assert.equal(stripCommentsForScan("Call(); // trailing {").trim(), "Call();");
  assert.equal(stripCommentsForScan("  * doc continuation {"), "");
  assert.equal(stripCommentsForScan("#define BRACE {"), "");
  assert.equal(stripCommentsForScan("A(/* inline */ B); ").trim(), "A(  B);");
  assert.equal(stripCommentsForScan("Code(); /* opens").trim(), "Code();");
});

test("classifyBlockHead names types and qualified methods only", () => {
  assert.equal(classifyBlockHead("void ANFCharacter::BeginPlay()")?.container, "ANFCharacter");
  assert.equal(classifyBlockHead("class ANFCharacter : public AActor")?.container, "ANFCharacter");
  assert.equal(classifyBlockHead("struct FNFStats")?.container, "FNFStats");
  assert.equal(classifyBlockHead("enum class ENFState : uint8")?.container, "ENFState");
  assert.equal(classifyBlockHead("UCLASS() class ANFHud : public AHUD")?.container, "ANFHud");

  // Not containers.
  assert.equal(classifyBlockHead("if (Health <= 0.f)"), null);
  assert.equal(classifyBlockHead("for (int32 I = 0; I < 4; ++I)"), null);
  assert.equal(classifyBlockHead("switch (State)"), null);
  assert.equal(classifyBlockHead("namespace NF"), null);
  assert.equal(classifyBlockHead("auto Fn = [this](int32 N)"), null);
  assert.equal(classifyBlockHead("void FreeHelper()"), null);
  assert.equal(classifyBlockHead(""), null);
  // Forward declaration — no body to be inside of.
  assert.equal(classifyBlockHead("class ANFCharacter;"), null);
});

test("guards: empty input, out-of-range lines, and a line budget", () => {
  assert.equal(resolveEnclosingContainer("", 1).container, null);
  assert.equal(resolveEnclosingContainer(SOURCE, 0).container, null);
  assert.equal(resolveEnclosingContainer(SOURCE, 9999).container, null);

  // A tight budget stops the walk before the class head is reached.
  const deep = `void ANFCharacter::BeginPlay()
{
${"    Pad();\n".repeat(40)}    Target();
}
`;
  assert.equal(
    resolveEnclosingContainer(deep, lineOf(deep, "Target();"), { maxLinesUp: 3 }).container,
    null,
  );
  assert.equal(
    resolveEnclosingContainer(deep, lineOf(deep, "Target();")).container,
    "ANFCharacter",
  );
});
