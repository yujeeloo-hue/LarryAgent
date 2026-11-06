/**
 * Phase 1 C++ local/parameter binding parser (cppLocalBindings.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cppIdentifierAt,
  resolveCppLocalBinding,
} from "./cppLocalBindings.js";

function posAt(
  text: string,
  snippet: string,
  ident: string,
): { line: number; column: number } {
  const index = text.indexOf(snippet);
  assert.notEqual(index, -1, `fixture missing: ${JSON.stringify(snippet)}`);
  const word = new RegExp(`(?:^|[^A-Za-z0-9_])(${ident})(?![A-Za-z0-9_])`);
  const innerMatch = word.exec(snippet);
  assert.ok(innerMatch?.[1], `ident ${ident} missing in snippet`);
  const inner = innerMatch.index + innerMatch[0].length - ident.length;
  const offset = index + inner;
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function resolveOn(
  text: string,
  snippet: string,
  ident: string,
) {
  const { line, column } = posAt(text, snippet, ident);
  const word = cppIdentifierAt(text, line, column);
  assert.equal(word?.name, ident);
  return resolveCppLocalBinding(text, line, column);
}

const SOURCE = `#include "ANFCharacter.h"

ANFCharacter::ANFCharacter(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
    PrimaryActorTick.bCanEverTick = true;
}

void ANFCharacter::BeginPlay()
{
    Super::BeginPlay();

    float Health = 100.f;
    FVector Offset(1.f, 2.f, 3.f);
    TArray<int32> Items;
    const FString& Title = GetName();
    AActor* Target = nullptr;

    if (UWorld* World = GetWorld())
    {
        UseWorld(World);
    }

    for (int32 Index = 0; Index < 4; ++Index)
    {
        TickOnce(Index);
    }

    for (AActor* Actor : Items)
    {
        Watch(Actor);
    }

    int32 Value = 1;
    {
        int32 Value = 2;
        UseInner(Value);
    }
    UseOuter(Value);

    auto Hidden = 0;
    auto* CastActor = Cast<ANFCharacter>(Target);
    auto Pawn = Controller->GetPawn<ANFCharacter>();
    auto GameState = UNFCommon::GetBattleGameState(this);
    Use(CastActor);
    Use(Pawn);
    Use(GameState);
    auto [First, Second] = Tie();
    int32 Alpha = 1, Beta = 2;
    UE_LOG(LogTemp, Warning, TEXT("hi"));
    Use(Hidden);
    Use(First);
    Use(Alpha);
}

void ANFCharacter::LongSignature(
    int32 ParamA,
    const TSubclassOf<AActor>& ClassType,
    AActor* Other)
{
    Use(ParamA);
    Use(ClassType);
    Use(Other);
}

float ANFCharacter::TakeDamage(float Damage, const FDamageEvent& DamageEvent)
{
    return Damage;
}

static void FreeHelper(const FString& Label)
{
    Use(Label);
}
`;

test("resolves a function parameter from a body usage", () => {
  const hit = resolveOn(SOURCE, "return Damage;", "Damage");
  assert.ok(hit);
  assert.equal(hit.kind, "parameter");
  assert.equal(hit.name, "Damage");
  assert.equal(hit.type, "float");
  const decl = posAt(SOURCE, "float Damage,", "Damage");
  assert.equal(hit.declarationLine, decl.line);
  assert.equal(hit.declarationColumn, decl.column);
  assert.ok(hit.functionRange.startLine <= decl.line);
  assert.ok(hit.functionRange.endLine >= posAt(SOURCE, "return Damage;", "Damage").line);
  assert.ok(hit.scope.startLine <= hit.declarationLine);
  assert.ok(hit.scope.endLine >= posAt(SOURCE, "return Damage;", "Damage").line);
});

test("resolves multiline pointer/ref/template parameters", () => {
  const a = resolveOn(SOURCE, "Use(ParamA);", "ParamA");
  assert.equal(a?.kind, "parameter");
  assert.equal(a?.type, "int32");

  const cls = resolveOn(SOURCE, "Use(ClassType);", "ClassType");
  assert.equal(cls?.kind, "parameter");
  assert.equal(cls?.type, "const TSubclassOf<AActor>&");
  const clsDecl = posAt(SOURCE, "const TSubclassOf<AActor>& ClassType,", "ClassType");
  assert.equal(cls?.declarationLine, clsDecl.line);

  const other = resolveOn(SOURCE, "Use(Other);", "Other");
  assert.equal(other?.kind, "parameter");
  assert.equal(other?.type, "AActor*");
});

test("resolves constructor parameters from the initializer list", () => {
  const hit = resolveOn(SOURCE, "Super(ObjectInitializer)", "ObjectInitializer");
  assert.equal(hit?.kind, "parameter");
  assert.equal(hit?.name, "ObjectInitializer");
  assert.equal(hit?.type, "const FObjectInitializer&");
});

test("resolves ordinary locals, constructor declarations, and template wrappers", () => {
  const health = resolveOn(SOURCE, "float Health = 100.f;", "Health");
  assert.equal(health?.kind, "local");
  assert.equal(health?.type, "float");

  const offset = resolveOn(SOURCE, "FVector Offset(1.f, 2.f, 3.f);", "Offset");
  assert.equal(offset?.kind, "local");
  assert.equal(offset?.type, "FVector");

  const items = resolveOn(SOURCE, "TArray<int32> Items;", "Items");
  assert.equal(items?.kind, "local");
  assert.equal(items?.type, "TArray<int32>");

  const title = resolveOn(SOURCE, "const FString& Title = GetName();", "Title");
  assert.equal(title?.kind, "local");
  assert.equal(title?.type, "const FString&");

  const target = resolveOn(SOURCE, "AActor* Target = nullptr;", "Target");
  assert.equal(target?.kind, "local");
  assert.equal(target?.type, "AActor*");
});

test("resolves for, range-for, and if initializers", () => {
  const world = resolveOn(SOURCE, "UseWorld(World);", "World");
  assert.equal(world?.kind, "local");
  assert.equal(world?.type, "UWorld*");
  const worldDecl = posAt(SOURCE, "if (UWorld* World = GetWorld())", "World");
  assert.equal(world?.declarationLine, worldDecl.line);

  const index = resolveOn(SOURCE, "TickOnce(Index);", "Index");
  assert.equal(index?.kind, "local");
  assert.equal(index?.type, "int32");

  const actor = resolveOn(SOURCE, "Watch(Actor);", "Actor");
  assert.equal(actor?.kind, "local");
  assert.equal(actor?.type, "AActor*");
  assert.equal(actor?.rangeExpression, "Items");
});

test("prefers the innermost shadowed local", () => {
  const inner = resolveOn(SOURCE, "UseInner(Value);", "Value");
  assert.equal(inner?.kind, "local");
  assert.equal(inner?.type, "int32");
  const innerDecl = posAt(SOURCE, "        int32 Value = 2;", "Value");
  assert.equal(inner?.declarationLine, innerDecl.line);

  const outer = resolveOn(SOURCE, "UseOuter(Value);", "Value");
  assert.equal(outer?.kind, "local");
  const outerDecl = posAt(SOURCE, "    int32 Value = 1;", "Value");
  assert.equal(outer?.declarationLine, outerDecl.line);
  assert.notEqual(inner?.declarationLine, outer?.declarationLine);
});

test("binds auto and infers explicit Unreal cast/getter types", () => {
  const hidden = resolveOn(SOURCE, "Use(Hidden);", "Hidden");
  assert.equal(hidden?.type, "auto");
  assert.equal(hidden?.inferredType, undefined);

  const cast = resolveOn(SOURCE, "Use(CastActor);", "CastActor");
  assert.equal(cast?.type, "auto*");
  assert.equal(cast?.inferredType, "ANFCharacter*");

  const pawn = resolveOn(SOURCE, "Use(Pawn);", "Pawn");
  assert.equal(pawn?.inferredType, "ANFCharacter*");

  const gameState = resolveOn(SOURCE, "Use(GameState);", "GameState");
  assert.equal(gameState?.initializerCall?.name, "GetBattleGameState");
});

test("skips structured bindings, comma multi-decls, and macros", () => {
  assert.equal(resolveOn(SOURCE, "Use(First);", "First"), null);
  assert.equal(resolveOn(SOURCE, "Use(Alpha);", "Alpha"), null);
  assert.equal(resolveOn(SOURCE, "UE_LOG(LogTemp, Warning, TEXT(\"hi\"));", "UE_LOG"), null);
});

test("does not bind a type name or a qualified member", () => {
  assert.equal(resolveOn(SOURCE, "float Damage,", "float"), null);
  assert.equal(resolveOn(SOURCE, "Super::BeginPlay();", "BeginPlay"), null);
  assert.equal(resolveOn(SOURCE, "PrimaryActorTick.bCanEverTick = true;", "bCanEverTick"), null);
});

test("resolves a free-function parameter", () => {
  const hit = resolveOn(SOURCE, "Use(Label);", "Label");
  assert.equal(hit?.kind, "parameter");
  assert.equal(hit?.type, "const FString&");
});

test("returns null outside a function", () => {
  const hit = resolveOn(SOURCE, "#include \"ANFCharacter.h\"", "ANFCharacter");
  assert.equal(hit, null);
});
