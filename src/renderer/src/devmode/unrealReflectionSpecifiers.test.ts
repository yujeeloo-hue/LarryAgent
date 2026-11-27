import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UE_META_SPECIFIERS,
  UE_SPECIFIER_ALIAS_SPELLINGS,
  UE_SPECIFIERS,
  isUeBoolName,
  isUeSpecifierName,
  planUeReflectionCompletion,
  reflectionContextAt,
  ueSpecifierItems,
  ueSpecifierVocabulary,
  ueValueItems,
  ueValueKind,
  type UeSpecifier,
} from "./unrealReflectionSpecifiers.js";

function at(marked: string): { text: string; caret: number } {
  const caret = marked.indexOf("|");
  assert.ok(caret >= 0, "test fixture needs a caret marker");
  return { text: marked.slice(0, caret) + marked.slice(caret + 1), caret };
}


test("specifier zone: caret directly inside a reflection macro's parens", () => {
  for (const macro of Object.keys(UE_SPECIFIERS)) {
    const { text, caret } = at(`${macro}(|)`);
    assert.deepEqual(
      reflectionContextAt(text, caret),
      { macro, zone: "specifier" },
      `expected the specifier zone inside ${macro}`,
    );
  }
});

test("specifier zone survives a second argument and a newline", () => {
  const multi = at("UPROPERTY(EditAnywhere,\n    BlueprintReadWrite|)");
  assert.deepEqual(reflectionContextAt(multi.text, multi.caret), {
    macro: "UPROPERTY",
    zone: "specifier",
  });
  const comma = at("UFUNCTION(BlueprintCallable, |)");
  assert.deepEqual(reflectionContextAt(comma.text, comma.caret), {
    macro: "UFUNCTION",
    zone: "specifier",
  });
});

test("meta zone: inside meta=( … ) of any reflection macro", () => {
  const plain = at("UPROPERTY(meta=(|))");
  assert.deepEqual(reflectionContextAt(plain.text, plain.caret), {
    macro: "UPROPERTY",
    zone: "meta",
  });
  const nested = at('UCLASS(meta=(DisplayName="X", |))');
  assert.deepEqual(reflectionContextAt(nested.text, nested.caret), {
    macro: "UCLASS",
    zone: "meta",
  });
});

test("value zone: bare identifier and quoted string", () => {
  const bare = at("UPROPERTY(ReplicatedUsing = OnRep_Hea|)");
  assert.deepEqual(reflectionContextAt(bare.text, bare.caret), {
    macro: "UPROPERTY",
    zone: "value",
    specifier: "ReplicatedUsing",
    quoted: false,
  });
  const quoted = at('UPROPERTY(meta=(EditCondition="bIsOpe|"))');
  assert.deepEqual(reflectionContextAt(quoted.text, quoted.caret), {
    macro: "UPROPERTY",
    zone: "value",
    specifier: "EditCondition",
    quoted: true,
  });
});

test("nested parens and commas inside strings do not shift the segment", () => {
  const { text, caret } = at('UPROPERTY(meta=(ToolTip="a, b", UIMin=0, |))');
  assert.deepEqual(reflectionContextAt(text, caret), { macro: "UPROPERTY", zone: "meta" });
});

test("outside a reflection macro there is no context", () => {
  const plainCall = at("Foo(a, |");
  assert.equal(reflectionContextAt(plainCall.text, plainCall.caret), null);
  const afterMacro = at("UPROPERTY(EditAnywhere)\nint32 Health|;");
  assert.equal(reflectionContextAt(afterMacro.text, afterMacro.caret), null);
  const plainCode = at("void ANFCharacter::BeginPlay|()");
  assert.equal(reflectionContextAt(plainCode.text, plainCode.caret), null);
});

test("comments, strings and other macros' arguments are not macro context", () => {
  const commented = at("// UPROPERTY(|");
  assert.equal(reflectionContextAt(commented.text, commented.caret), null);
  const inString = at('FString S = "UPROPERTY(|";');
  assert.equal(reflectionContextAt(inString.text, inString.caret), null);
  const otherArgs = at("IMPLEMENT_MODULE(FDefaultModuleImpl, |)");
  assert.equal(reflectionContextAt(otherArgs.text, otherArgs.caret), null);
});

test("a macro far above the caret is out of scope", () => {
  const filler = "int32 Pad = 0;\n".repeat(300);
  const { text, caret } = at(`UPROPERTY(\n${filler}int32 Health|;`);
  assert.equal(reflectionContextAt(text, caret), null);
});


test("specifier rows are macro-scoped and prefix-filtered", () => {
  const property = { macro: "UPROPERTY" as const, zone: "specifier" as const };
  const names = ueSpecifierItems(property, "Blueprint").map((item) => item.label);
  assert.ok(names.includes("BlueprintReadWrite"));
  assert.ok(!names.includes("BlueprintNativeEvent"), "UFUNCTION-only specifier leaked");
  assert.ok(!names.includes("EditAnywhere"), "prefix filtering failed");

  const func = ueSpecifierItems({ macro: "UFUNCTION", zone: "specifier" }, "Blueprint");
  assert.ok(func.map((item) => item.label).includes("BlueprintNativeEvent"));
  assert.ok(!func.map((item) => item.label).includes("BlueprintReadWrite"));
});

test("specifier rows carry a description and never repeat the typed word", () => {
  const items = ueSpecifierItems({ macro: "UPROPERTY", zone: "specifier" }, "EditAnywhere");
  assert.ok(!items.some((item) => item.label === "EditAnywhere"));
  const edit = ueSpecifierItems({ macro: "UPROPERTY", zone: "specifier" }, "EditA");
  assert.ok(edit.length > 0);
  for (const item of edit) {
    assert.ok(item.detail && item.detail.length > 0, `missing doc: ${item.label}`);
    assert.equal(item.insertText, item.label);
    assert.equal(item.isSnippet, false);
    assert.equal(item.kind, 14, "specifiers are keyword-kind rows");
  }
});

test("the meta row inserts the whole meta=(…) snippet", () => {
  const items = ueSpecifierItems({ macro: "UPROPERTY", zone: "specifier" }, "met");
  const meta = items.find((item) => item.label === "meta");
  assert.ok(meta);
  assert.equal(meta.insertText, "meta=($0)");
  assert.equal(meta.isSnippet, true);
});

test("meta zone lists metadata keys only", () => {
  const items = ueSpecifierItems({ macro: "UPROPERTY", zone: "meta" }, "");
  const names = items.map((item) => item.label);
  assert.ok(names.includes("EditCondition"));
  assert.ok(names.includes("DisplayName"));
  assert.ok(!names.includes("BlueprintReadWrite"), "property specifier leaked into meta");
  assert.equal(names.length, UE_META_SPECIFIERS.length, "meta rows stay complete");
});


test("value kind follows the quoted/bare syntax per specifier", () => {
  assert.equal(
    ueValueKind({ macro: "UPROPERTY", zone: "value", specifier: "ReplicatedUsing", quoted: false }, "ReplicatedUsing"),
    "function",
  );
  assert.equal(
    ueValueKind({ macro: "UPROPERTY", zone: "value", specifier: "ReplicatedUsing", quoted: true }, "ReplicatedUsing"),
    null,
    "a function reference is bare",
  );
  assert.equal(
    ueValueKind({ macro: "UPROPERTY", zone: "meta", specifier: "EditCondition", quoted: true }, "EditCondition"),
    "bool",
  );
  assert.equal(
    ueValueKind({ macro: "UPROPERTY", zone: "meta", specifier: "EditCondition", quoted: false }, "EditCondition"),
    null,
    "a bool condition lives in a string",
  );
  assert.equal(
    ueValueKind({ macro: "UPROPERTY", zone: "specifier", specifier: "Category", quoted: true }, "Category"),
    null,
    "free-text specifiers offer nothing",
  );
});

test("ReplicatedUsing ranks OnRep_ functions first", () => {
  const items = ueValueItems(
    "function",
    "ReplicatedUsing",
    [
      { name: "GetHealth", kind: "function", params: "float" },
      { name: "OnRep_Health", kind: "function", params: "" },
      { name: "OnRep_MaxHealth", kind: "function", params: "" },
      { name: "Health", kind: "variable" },
    ],
    [],
  );
  assert.deepEqual(
    items.map((item) => item.label),
    ["OnRep_Health", "OnRep_MaxHealth", "GetHealth"],
    "OnRep_ first, variables dropped",
  );
  for (const item of items) {
    assert.equal(item.insertText, item.label, "values insert the bare name");
    assert.equal(item.isSnippet, false);
  }
});

test("EditCondition offers bool members and bool-returning functions", () => {
  const items = ueValueItems(
    "bool",
    "EditCondition",
    [
      { name: "bIsOpen", kind: "variable", depth: 0 },
      { name: "Health", kind: "variable", depth: 0 },
      { name: "IsAlive", kind: "function", returnType: "bool", depth: 0 },
      { name: "GetMesh", kind: "function", returnType: "USkeletalMeshComponent*", depth: 0 },
    ],
    ["bUseAdvanced", "SomeLocal"],
  );
  const labels = items.map((item) => item.label);
  assert.deepEqual(labels.slice(0, 2), ["bIsOpen", "IsAlive"]);
  assert.ok(labels.includes("bUseAdvanced"), "buffer fallback kept when the index is cold");
  assert.ok(!labels.includes("Health"));
  assert.ok(!labels.includes("GetMesh"));
  assert.ok(!labels.includes("SomeLocal"));
});


test("plan: specifiers, values and nothing-to-offer cases", () => {
  const specifiers = at("UPROPERTY(EditA|)");
  const specifierPlan = planUeReflectionCompletion(specifiers.text, specifiers.caret);
  assert.equal(specifierPlan?.kind, "items");
  if (specifierPlan?.kind === "items") {
    assert.equal(specifierPlan.prefix, "EditA");
    assert.deepEqual(
      specifierPlan.items.map((item) => item.label),
      ["EditAnywhere"],
    );
  }

  const value = at("UPROPERTY(ReplicatedUsing = OnRep|)");
  const valuePlan = planUeReflectionCompletion(value.text, value.caret);
  assert.equal(valuePlan?.kind, "value");
  if (valuePlan?.kind === "value") {
    assert.equal(valuePlan.valueKind, "function");
    assert.equal(valuePlan.specifier, "ReplicatedUsing");
    assert.equal(valuePlan.prefix, "OnRep");
  }

  const freeText = at('UPROPERTY(Category="Comba|t")');
  assert.equal(planUeReflectionCompletion(freeText.text, freeText.caret)?.kind, "none");

  const code = at("int32 Health|;");
  assert.equal(planUeReflectionCompletion(code.text, code.caret), null);
});


test("vocabulary rows are unique and documented", () => {
  for (const [macro, list] of Object.entries(UE_SPECIFIERS)) {
    const seen = new Set<string>();
    for (const entry of list) {
      assert.ok(!seen.has(entry.name), `${macro}: duplicate ${entry.name}`);
      seen.add(entry.name);
      assert.ok(entry.doc.length > 0, `${macro}.${entry.name} has no doc`);
      assert.ok(entry.doc.length <= 60, `${macro}.${entry.name} doc too long for a row`);
    }
  }
  const metaSeen = new Set<string>();
  for (const entry of UE_META_SPECIFIERS) {
    assert.ok(!metaSeen.has(entry.name), `meta: duplicate ${entry.name}`);
    metaSeen.add(entry.name);
    assert.ok(entry.doc.length > 0);
  }
});

test("the colorizer vocabulary is derived from the specifier lists", () => {
  const words = new Set(ueSpecifierVocabulary());
  const declared: UeSpecifier[] = Object.values(UE_SPECIFIERS).flatMap((list) => [...list]);
  for (const entry of [...declared, ...UE_META_SPECIFIERS]) {
    assert.ok(words.has(entry.name), `missing from vocabulary: ${entry.name}`);
    assert.ok(isUeSpecifierName(entry.name));
  }
  for (const alias of UE_SPECIFIER_ALIAS_SPELLINGS) {
    assert.ok(words.has(alias), `lower-case alias not colorable: ${alias}`);
    assert.ok(isUeSpecifierName(alias));
  }
  for (const legacy of [
    "AdvancedDisplay",
    "AllowPrivateAccess",
    "AssetRegistrySearchable",
    "BlueprintAssignable",
    "BlueprintCallable",
    "BlueprintImplementableEvent",
    "BlueprintNativeEvent",
    "BlueprintPure",
    "BlueprintReadOnly",
    "BlueprintReadWrite",
    "BlueprintSetter",
    "BlueprintGetter",
    "BlueprintType",
    "Blueprintable",
    "Category",
    "ClampMax",
    "ClampMin",
    "Config",
    "config",
    "customconstructor",
    "DontCollapseCategories",
    "DuplicateTransient",
    "EditAnywhere",
    "EditDefaultsOnly",
    "EditFixedSize",
    "EditInlineNew",
    "EditInstanceOnly",
    "Exec",
    "ExposeOnSpawn",
    "ExposeFunctionOnSpawn",
    "ForceUnits",
    "GlobalUserConfig",
    "hidecategories",
    "Instanced",
    "meta",
    "MinimalAPI",
    "NetMulticast",
    "NoClear",
    "Reliable",
    "Replicated",
    "ReplicatedUsing",
    "SaveGame",
    "Server",
    "showcategories",
    "SimpleDisplay",
    "Transient",
    "UIMax",
    "UIMin",
    "Units",
    "Unreliable",
    "VisibleAnywhere",
    "VisibleDefaultsOnly",
    "VisibleInstanceOnly",
    "WithValidation",
    "Within",
  ]) {
    assert.ok(isUeSpecifierName(legacy), `colorizer word lost: ${legacy}`);
  }
  assert.ok(!isUeSpecifierName("EditAnywhereMaybe"));
  assert.ok(!isUeSpecifierName(""));
});

test("bool naming heuristic matches UE convention", () => {
  assert.ok(isUeBoolName("bIsOpen"));
  assert.ok(isUeBoolName("bReplicates"));
  assert.ok(!isUeBoolName("bX"));
  assert.ok(!isUeBoolName("Health"));
});
