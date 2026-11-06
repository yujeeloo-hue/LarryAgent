import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bufferIdentifiers,
  localNamesInScope,
  quickBareCompletionItems,
  buildTextCompletionItems,
  callContextAt,
  commonTypeHits,
  completionContextAt,
  keywordItems,
  localTypeOf,
  ueMacroHits,
  memberAccessType,
  signatureFromHit,
} from "./cppTextCompletion.js";

test("caret context recognises this->, receivers, scopes and bare names", () => {
  assert.deepEqual(completionContextAt("    this->"), { prefix: "", access: "this" });
  assert.deepEqual(completionContextAt("    this->Att"), { prefix: "Att", access: "this" });
  assert.deepEqual(completionContextAt("  Weapon->Fi"), { prefix: "Fi", access: "member", name: "Weapon" });
  assert.deepEqual(completionContextAt("  Hit.Loc"), { prefix: "Loc", access: "member", name: "Hit" });
  assert.deepEqual(completionContextAt("  GetOwner()->"), { prefix: "", access: "member-unknown" });
  assert.deepEqual(completionContextAt("  TargetCharacter->AudioTriggerCfg->"), {
    prefix: "",
    access: "member",
    name: "AudioTriggerCfg",
    chain: ["TargetCharacter", "AudioTriggerCfg"],
  });
  assert.deepEqual(completionContextAt("  TargetCharacter->AudioTriggerCfg->Pl"), {
    prefix: "Pl",
    access: "member",
    name: "AudioTriggerCfg",
    chain: ["TargetCharacter", "AudioTriggerCfg"],
  });
  assert.deepEqual(completionContextAt("  this->AudioTriggerCfg->"), {
    prefix: "",
    access: "member",
    name: "AudioTriggerCfg",
    chain: ["this", "AudioTriggerCfg"],
  });
  assert.deepEqual(completionContextAt("  Super::Begin"), { prefix: "Begin", access: "scope", name: "Super" });
  assert.deepEqual(completionContextAt("  float X = 1."), { prefix: "", access: "none" });
  assert.deepEqual(completionContextAt("  Attac"), { prefix: "Attac", access: "none" });
});

test("member access types unwrap UE pointer wrappers and qualifiers", () => {
  assert.equal(memberAccessType("TObjectPtr<UWeaponComponent>"), "UWeaponComponent");
  assert.equal(memberAccessType("const FHitResult&"), "FHitResult");
  assert.equal(memberAccessType("AActor*"), "AActor");
  assert.equal(memberAccessType("TWeakObjectPtr<class APawn>"), "APawn");
  assert.equal(memberAccessType("auto"), null);
});

test("local receiver types come from the nearest declaration", () => {
  const before = `void ANFCharacter::Tick(float Dt, const FHitResult& Hit)
{
    AActor* Target = GetOwner();
    return Target;
    Target`;
  assert.equal(localTypeOf(before, "Target"), "AActor");
  assert.equal(localTypeOf(before, "Hit"), "FHitResult");
  assert.equal(localTypeOf(before, "Unknown"), null);
  const call = `void GetSoundConfig(ANFCharacter* TargetCharacter, int32 HeroID)
{
    TargetCharacter->AudioTriggerCfg->`;
  assert.equal(localTypeOf(call, "TargetCharacter"), "ANFCharacter");
});

test("buffer identifiers rank by distance and skip the typed token", () => {
  const text = "int32 AttackPower; void Foo() { AttackCount = 1; Att }";
  const caret = text.indexOf("Att }") + 3;
  assert.deepEqual(bufferIdentifiers(text, caret, "Att"), ["AttackCount", "AttackPower"]);
});

test("local names are a search of the enclosing function, not the whole file", () => {
  const text = `void Other() { int32 AttackOther = 1; }
void Foo(int32 AttackParam) {
    int32 AttackLocal = 2;
    Att
}`;
  const caret = text.indexOf("Att\n") + 3;
  const names = localNamesInScope(text, caret, "Att");
  assert.deepEqual(names, ["AttackLocal", "AttackParam"]);
  const nested = `void Other() { int32 AttackOther = 1; }
void Foo(int32 AttackParam) {
    int32 AttackLocal = 2;
    if (true) {
        Att
    }
}`;
  const nestedCaret = nested.indexOf("Att\n") + 3;
  assert.deepEqual(localNamesInScope(nested, nestedCaret, "Att"), ["AttackLocal", "AttackParam"]);
  const quick = quickBareCompletionItems(text, caret, "Att").map((item) => item.label);
  assert.ok(quick.includes("AttackLocal") && quick.includes("AttackParam"));
  assert.equal(quick.includes("AttackOther"), false);
});

test("empty prefix lists nearby words only for an explicit Ctrl+Space", () => {
  const text = "int32 AttackPower; void Foo() { AttackCount = 1;  }";
  const caret = text.indexOf("  }") + 1;
  assert.deepEqual(bufferIdentifiers(text, caret, ""), []);
  const words = bufferIdentifiers(text, caret, "", 40, true);
  assert.equal(words[0], "AttackCount");
  assert.ok(words.includes("AttackPower") && !words.includes("void"));
});

test("index hits become Rider-style items: members before words before globals", () => {
  const items = buildTextCompletionItems(
    [
      { name: "Attack", kind: "function", container: "ANFCharacter", params: "float Damage", returnType: "void", depth: 0 },
      { name: "AttackHeavy", kind: "function", container: "ANFCharacter", params: "", depth: 0 },
      { name: "AttachLogger", kind: "function" },
    ],
    ["AttackCount", "Attack"],
  );
  assert.deepEqual(items.map((i) => i.label), ["Attack", "AttackHeavy", "AttachLogger", "AttackCount"]);
  assert.equal(items[0]!.insertText, "Attack($0)");
  assert.equal(items[0]!.showParameterHints, true);
  assert.equal(items[0]!.signature, "(float Damage)");
  assert.equal(items[1]!.insertText, "AttackHeavy()");
  assert.equal(items[1]!.showParameterHints, false);
  const order = items.map((i) => i.sortText);
  assert.ok(order[0]! < order[3]! && order[3]! < order[2]!);
});

test("bands: own members, current-file words, inherited members, globals, keywords", () => {
  const items = [
    ...buildTextCompletionItems(
      [
        { name: "Jump", kind: "function", container: "ACharacter", depth: 1, paramsUnknown: true },
        { name: "GEngine", kind: "variable" },
        { name: "Attack", kind: "function", container: "ANFCharacter", depth: 0, params: "" },
        { name: "UE_LOG", kind: "type", macro: true },
      ],
      ["LocalTarget"],
    ),
    ...keywordItems("re"),
  ];
  const ranked = [...items].sort((a, b) => (a.sortText < b.sortText ? -1 : 1)).map((i) => i.label);
  assert.deepEqual(ranked, ["Attack", "LocalTarget", "Jump", "GEngine", "UE_LOG", "reinterpret_cast", "return"]);
  assert.equal(items.find((i) => i.label === "UE_LOG")!.kind, 21, "macros use the constant icon");
  assert.deepEqual(keywordItems("r"), [], "keywords need 2+ chars");
});

test("common Unreal types match locally, including without the type prefix", () => {
  assert.deepEqual(
    commonTypeHits("Vec").map((h) => h.name),
    ["FVector", "FVector2D", "FVector4"],
  );
  assert.deepEqual(
    commonTypeHits("fve").map((h) => h.name),
    ["FVector", "FVector2D", "FVector4"],
  );
  assert.deepEqual(commonTypeHits("Arr").map((h) => h.name), ["TArray"]);
  assert.deepEqual(commonTypeHits("Fv"), [], "3 characters before common types appear");
  const ranked = [...buildTextCompletionItems(
    [...commonTypeHits("Str"), { name: "StreamOut", kind: "function" }],
    [],
  )]
    .sort((a, b) => (a.sortText < b.sortText ? -1 : 1))
    .map((i) => i.label);
  assert.deepEqual(ranked, ["FString", "StreamOut"], "curated types rank ahead of index globals");
});

test("built-in Unreal macros: call shape decides the insert text", () => {
  const byName = (prefix: string) =>
    buildTextCompletionItems(ueMacroHits(prefix), []).map((i) => [i.label, i.insertText, i.kind]);
  assert.deepEqual(byName("UE_L"), [
    ["UE_LOG", "UE_LOG($0)", 21],
    ["UE_LOGFMT", "UE_LOGFMT($0)", 21],
  ]);
  assert.deepEqual(byName("GENERATED_B"), [["GENERATED_BODY", "GENERATED_BODY()", 21]]);
  assert.deepEqual(byName("INDEX_"), [["INDEX_NONE", "INDEX_NONE", 21]]);
  assert.deepEqual(ueMacroHits("c"), [], "2+ chars before the list chimes in");
});

test("index functions with unknown arity insert Name(|) with parameter hints", () => {
  const [item] = buildTextCompletionItems(
    [{ name: "GetActorLocation", kind: "function", container: "AActor", depth: 3, paramsUnknown: true }],
    [],
  );
  assert.equal(item!.insertText, "GetActorLocation($0)");
  assert.equal(item!.showParameterHints, true);
  assert.equal(item!.signature, "(…)");
});

test("call context finds the innermost open call and active argument", () => {
  assert.deepEqual(callContextAt("    Attack(10.f, "), { name: "Attack", activeParameter: 1 });
  assert.deepEqual(callContextAt("    Weapon->Fire(Get(1, 2), "), {
    name: "Fire",
    owner: "Weapon",
    activeParameter: 1,
  });
  assert.equal(callContextAt("    if (Ready) { Go(); }"), null);
  assert.equal(callContextAt("    Attack(1); X"), null);
});

test("signature label from an index hit splits top-level params", () => {
  const sig = signatureFromHit({
    name: "Attack",
    params: "float Damage, TMap<FName, int32> Combos",
    returnType: "void",
    container: "ANFCharacter",
  });
  assert.equal(sig.label, "void ANFCharacter::Attack(float Damage, TMap<FName, int32> Combos)");
  assert.deepEqual(sig.parameters, ["float Damage", "TMap<FName, int32> Combos"]);
});
