import assert from "node:assert/strict";
import { test } from "node:test";

import {
  maskCpp,
  scanImplBodies,
  scanUnrealClass,
  splitSpecifiers,
  stripDefaultArgs,
} from "./unrealNetScan.js";
import {
  parsePushModelSetting,
  planUnrealNetCodegen,
  type NetCodegenEdit,
} from "./unrealNetCodegen.js";

export function applyEdits(text: string, edits: readonly NetCodegenEdit[]): string {
  const lines = text.split(/\r?\n/);
  const offsets: number[] = [];
  let running = 0;
  for (const line of lines) {
    offsets.push(running);
    running += line.length + 1;
  }
  const ordered = [...edits]
    .map((edit) => ({
      edit,
      offset: (offsets[edit.startLine - 1] ?? text.length) + edit.startColumn - 1,
    }))
    .sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const entry of ordered) {
    out = out.slice(0, entry.offset) + entry.edit.text + out.slice(entry.offset);
  }
  return out;
}

const HEADER = `// Copyright Epic Games, Inc. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "MyActor.generated.h"

UCLASS()
class TPSDEMO_API AMyActor : public AActor
{
	GENERATED_BODY()

public:
	AMyActor();

	UPROPERTY(Replicated, BlueprintReadOnly)
	int32 Health = 100;

	UPROPERTY(ReplicatedUsing=OnRep_Score)
	float Score = 0.f;

	UFUNCTION(Server, Reliable, WithValidation)
	void ServerTakeDamage(int32 Amount, const FVector& Origin = FVector::ZeroVector);

	UFUNCTION(NetMulticast, Unreliable)
	void MulticastExplode();
};
`;

const SOURCE = `// Copyright Epic Games, Inc. All Rights Reserved.

#include "MyActor.h"

AMyActor::AMyActor()
{
	bReplicates = true;
}
`;

test("scanUnrealClass keeps specifiers, params and access", () => {
  const scan = scanUnrealClass(HEADER);
  assert.ok(scan);
  assert.equal(scan.className, "AMyActor");
  assert.deepEqual(scan.bases, ["AActor"]);
  const byName = new Map(scan.members.map((m) => [m.name, m]));
  assert.deepEqual(
    byName.get("Health")?.specifiers,
    ["Replicated", "BlueprintReadOnly"],
  );
  assert.equal(byName.get("Health")?.type, "int32");
  assert.equal(byName.get("Health")?.access, "public");
  assert.equal(byName.get("Score")?.values.replicatedusing, "OnRep_Score");
  assert.deepEqual(byName.get("ServerTakeDamage")?.specifiers, [
    "Server",
    "Reliable",
    "WithValidation",
  ]);
  assert.equal(
    byName.get("ServerTakeDamage")?.params,
    "int32 Amount, const FVector& Origin = FVector::ZeroVector",
  );
  assert.deepEqual(byName.get("MulticastExplode")?.specifiers, [
    "NetMulticast",
    "Unreliable",
  ]);
});

test("maskCpp blanks comments and literals but keeps offsets", () => {
  const src = 'FString S = "a { b"; // } brace\n/* } */ int32 X = 1;\n';
  const masked = maskCpp(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split("\n").length, src.split("\n").length);
  assert.ok(!masked.includes("{ b"));
  assert.ok(!masked.includes("brace"));
});

test("splitSpecifiers / stripDefaultArgs", () => {
  const parsed = splitSpecifiers('Server, Reliable, meta=(Key="a,b"), Server=Implement');
  assert.deepEqual(parsed.specifiers, [
    "Server",
    "Reliable",
    'meta=(Key="a,b")',
    "Server=Implement",
  ]);
  assert.equal(parsed.values.server, "Implement");
  assert.equal(
    stripDefaultArgs("int32 A = 0, const FVector& B = FVector::ZeroVector, float C"),
    "int32 A, const FVector& B, float C",
  );
});

test("scanImplBodies finds definitions with brace ranges", () => {
  const bodies = scanImplBodies(SOURCE, "AMyActor");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.name, "AMyActor");
  assert.equal(bodies[0]?.openLine, 6);
  assert.equal(bodies[0]?.closeLine, 8);
});

test("plans implementations, RepNotify and registrations", () => {
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: HEADER,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: SOURCE,
    scope: "class",
    pushModel: false,
  });
  assert.equal(plan.advisories.filter((a) => a.includes("Parent")).length, 0);
  const header = applyEdits(HEADER, plan.files.find((f) => f.path.endsWith(".h"))!.edits);
  const source = applyEdits(SOURCE, plan.files.find((f) => f.path.endsWith(".cpp"))!.edits);

  assert.match(header, /virtual void ServerTakeDamage_Implementation\(int32 Amount, const FVector& Origin\);/);
  assert.match(header, /virtual bool ServerTakeDamage_Validate\(int32 Amount, const FVector& Origin\);/);
  assert.match(header, /virtual void MulticastExplode_Implementation\(\);/);
  assert.match(header, /UFUNCTION\(\)\n\tvoid OnRep_Score\(\);/);
  assert.match(header, /virtual void GetLifetimeReplicatedProps\(TArray<FLifetimeProperty>& OutLifetimeProps\) const override;/);

  assert.match(source, /#include "Net\/UnrealNetwork\.h"/);
  assert.match(source, /void AMyActor::ServerTakeDamage_Implementation\(int32 Amount, const FVector& Origin\)\n\{\n\}/);
  assert.match(source, /bool AMyActor::ServerTakeDamage_Validate\(int32 Amount, const FVector& Origin\)\n\{\n\treturn true;\n\}/);
  assert.match(source, /void AMyActor::MulticastExplode_Implementation\(\)\n\{\n\}/);
  assert.match(source, /void AMyActor::OnRep_Score\(\)\n\{\n\}/);
  assert.match(
    source,
    /void AMyActor::GetLifetimeReplicatedProps\(TArray<FLifetimeProperty>& OutLifetimeProps\) const\n\{\n\tSuper::GetLifetimeReplicatedProps\(OutLifetimeProps\);\n\n\tDOREPLIFETIME\(AMyActor, Health\);\n\tDOREPLIFETIME\(AMyActor, Score\);\n\}/,
  );
});

test("second run is a no-op (idempotent)", () => {
  const first = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: HEADER,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: SOURCE,
    scope: "class",
    pushModel: false,
  });
  const header = applyEdits(HEADER, first.files.find((f) => f.path.endsWith(".h"))!.edits);
  const source = applyEdits(SOURCE, first.files.find((f) => f.path.endsWith(".cpp"))!.edits);
  const second = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: source,
    scope: "class",
    pushModel: false,
  });
  assert.deepEqual(second.files, []);
  assert.deepEqual(second.summary.created, []);
  assert.ok(second.summary.alreadyPresent.length > 0);
});

test("existing declarations and registrations are respected", () => {
  const header = HEADER.replace(
    "\tUFUNCTION(NetMulticast, Unreliable)\n\tvoid MulticastExplode();",
    "\tUFUNCTION(NetMulticast, Unreliable)\n\tvoid MulticastExplode();\n\n\tvirtual void MulticastExplode_Implementation();\n\n\tvirtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;",
  );
  const source = `${SOURCE}
void AMyActor::MulticastExplode_Implementation()
{
}

void AMyActor::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);

	DOREPLIFETIME_CONDITION(AMyActor, Health, COND_OwnerOnly);
	DOREPLIFETIME(AMyActor, Score);
}
`;
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: source,
    scope: "class",
    pushModel: false,
  });
  const headerPlan = plan.files.find((f) => f.path.endsWith(".h"));
  const editedHeader = headerPlan ? applyEdits(header, headerPlan.edits) : header;
  const sourcePlan = plan.files.find((f) => f.path.endsWith(".cpp"));
  const edited = sourcePlan ? applyEdits(source, sourcePlan.edits) : source;
  assert.equal(edited.match(/DOREPLIFETIME\(AMyActor, Health\)/g), null);
  assert.equal(edited.match(/DOREPLIFETIME\(AMyActor, Score\)/g)?.length, 1);
  assert.equal(edited.match(/MulticastExplode_Implementation/g)?.length, 1);
  assert.equal(editedHeader.match(/MulticastExplode_Implementation/g)?.length, 1);
  assert.equal(
    editedHeader.match(/GetLifetimeReplicatedProps/g)?.length,
    1,
  );
  assert.ok(plan.summary.alreadyPresent.includes("Health registration"));
});

test("push model adds params, dirty marks and PushModel include", () => {
  const header = HEADER.replace(
    "\tUFUNCTION(Server, Reliable, WithValidation)",
    "\tvoid SetHealth(int32 InValue);\n\n\tUPROPERTY(Replicated)\n\tTArray<int32> Items;\n\n\tUFUNCTION(Server, Reliable, WithValidation)",
  );
  const source = `${SOURCE}
void AMyActor::SetHealth(int32 InValue)
{
	Health = InValue;
}
`;
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: source,
    scope: "class",
    pushModel: true,
  });
  const editedHeader = applyEdits(header, plan.files.find((f) => f.path.endsWith(".h"))!.edits);
  const editedSource = applyEdits(source, plan.files.find((f) => f.path.endsWith(".cpp"))!.edits);
  assert.match(editedSource, /#include "Net\/Core\/PushModel\/PushModel\.h"/);
  assert.match(editedSource, /FDoRepLifetimeParams Params;\n\tParams\.bIsPushBased = true;/);
  assert.match(editedSource, /DOREPLIFETIME_WITH_PARAMS_FAST\(AMyActor, Health, Params\);/);
  assert.match(
    editedSource,
    /void AMyActor::SetHealth\(int32 InValue\)\n\{\n\tHealth = InValue;\n\tMARK_PROPERTY_DIRTY_FROM_NAME\(AMyActor, Health, this\);\n\}/,
  );
  assert.match(editedSource, /DOREPLIFETIME\(AMyActor, Items\);/);
  assert.match(
    editedSource,
    /void AMyActor::SetScore\(float InValue\)/,
  );
  assert.ok(plan.advisories.some((a) => a.includes("Items")));
  assert.ok(editedHeader.includes("GetLifetimeReplicatedProps"));
});

test("static arrays use the static-array macro", () => {
  const header = HEADER.replace(
    "\tUPROPERTY(Replicated, BlueprintReadOnly)\n\tint32 Health = 100;",
    "\tUPROPERTY(Replicated, BlueprintReadOnly)\n\tint32 Slots[4];",
  );
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: SOURCE,
    scope: "class",
    pushModel: false,
  });
  const source = applyEdits(SOURCE, plan.files.find((f) => f.path.endsWith(".cpp"))!.edits);
  assert.match(
    source,
    /DOREPLIFETIME_WITH_PARAMS_FAST_STATIC_ARRAY\(AMyActor, Slots, FDoRepLifetimeParams\(\)\);/,
  );
});

test("push model skips properties assigned directly in the source", () => {
  const header = HEADER.replace(
    "\tUFUNCTION(Server, Reliable, WithValidation)",
    "\tvoid SetHealth(int32 InValue);\n\n\tUFUNCTION(Server, Reliable, WithValidation)",
  );
  const source = `${SOURCE}
void AMyActor::ApplyDamage(int32 Amount)
{
	Health -= Amount;
	Health = FMath::Max(0, Health);
}
`;
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: source,
    scope: "class",
    pushModel: true,
  });
  const edited = applyEdits(source, plan.files.find((f) => f.path.endsWith(".cpp"))!.edits);
  assert.match(edited, /DOREPLIFETIME\(AMyActor, Health\);/);
  assert.doesNotMatch(edited, /_WITH_PARAMS_FAST\(AMyActor, Health/);
  assert.ok(plan.advisories.some((a) => a.includes("assigned directly")));
  const editedHeader = applyEdits(header, plan.files.find((f) => f.path.endsWith(".h"))!.edits);
  assert.equal(editedHeader.match(/void SetHealth\(int32 InValue\);/g)?.length, 1);
});

test("a dirty mark elsewhere in the file counts as already present", () => {
  const header = HEADER.replace(
    "\tUFUNCTION(Server, Reliable, WithValidation)",
    "\tvoid SetHealth(int32 InValue);\n\n\tUFUNCTION(Server, Reliable, WithValidation)",
  );
  const source = `${SOURCE}
void AMyActor::SetHealth(int32 InValue)
{
	SetHealthInternal(InValue);
}

void AMyActor::SetHealthInternal(int32 InValue)
{
	Health = InValue;
	MARK_PROPERTY_DIRTY_FROM_NAME(AMyActor, Health, this);
}
`;
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: source,
    scope: "class",
    pushModel: true,
  });
  assert.ok(plan.summary.alreadyPresent.includes("Health dirty mark"));
  assert.ok(!plan.advisories.some((a) => a.includes("SetHealth() has no simple")));
});

test("Server= / WithValidation= override the generated names", () => {
  const header = HEADER.replace(
    "\tUFUNCTION(Server, Reliable, WithValidation)\n\tvoid ServerTakeDamage(int32 Amount, const FVector& Origin = FVector::ZeroVector);",
    "\tUFUNCTION(Server, Reliable, WithValidation)\n\tvoid ServerTakeDamage(int32 Amount);",
  ).replace(
    "\tUFUNCTION(Server, Reliable, WithValidation)\n\tvoid ServerTakeDamage(int32 Amount);",
    "\tUFUNCTION(Server=DoServerTakeDamage, Reliable, WithValidation=DoValidate)\n\tvoid ServerTakeDamage(int32 Amount);",
  );
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: SOURCE,
    scope: "class",
    pushModel: false,
  });
  const editedHeader = applyEdits(header, plan.files.find((f) => f.path.endsWith(".h"))!.edits);
  const editedSource = applyEdits(SOURCE, plan.files.find((f) => f.path.endsWith(".cpp"))!.edits);
  assert.match(editedHeader, /virtual void DoServerTakeDamage\(int32 Amount\);/);
  assert.match(editedHeader, /virtual bool DoValidate\(int32 Amount\);/);
  assert.doesNotMatch(editedHeader, /ServerTakeDamage_Implementation/);
  assert.match(editedSource, /void AMyActor::DoServerTakeDamage\(int32 Amount\)/);
  assert.match(editedSource, /bool AMyActor::DoValidate\(int32 Amount\)/);
});

test("BlueprintNativeEvent gets _Implementation with its return type", () => {
  const header = HEADER.replace(
    "\tUFUNCTION(Server, Reliable, WithValidation)\n\tvoid ServerTakeDamage(int32 Amount, const FVector& Origin = FVector::ZeroVector);",
    "\tUFUNCTION(BlueprintNativeEvent, BlueprintCallable)\n\tFVector ComputeAim(const FVector& From) const;",
  );
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: SOURCE,
    scope: "class",
    pushModel: false,
  });
  const editedHeader = applyEdits(header, plan.files.find((f) => f.path.endsWith(".h"))!.edits);
  const editedSource = applyEdits(SOURCE, plan.files.find((f) => f.path.endsWith(".cpp"))!.edits);
  assert.match(editedHeader, /virtual FVector ComputeAim_Implementation\(const FVector& From\);/);
  assert.match(editedSource, /FVector AMyActor::ComputeAim_Implementation\(const FVector& From\)/);
});

test("a definition inside #if counts as present", () => {
  const source = `${SOURCE}
#if WITH_EDITOR
void AMyActor::MulticastExplode_Implementation()
{
}
#endif
`;
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: HEADER,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: source,
    scope: "class",
    pushModel: false,
  });
  assert.ok(plan.summary.alreadyPresent.includes("MulticastExplode_Implementation() definition"));
  const edited = applyEdits(source, plan.files.find((f) => f.path.endsWith(".cpp"))!.edits);
  assert.equal(edited.match(/MulticastExplode_Implementation/g)?.length, 1);
});

test("USTRUCT with Replicated is refused with an advisory", () => {
  const header = `#pragma once
#include "CoreMinimal.h"
#include "MyStruct.generated.h"

USTRUCT()
struct FMyNetState
{
	GENERATED_BODY()

	UPROPERTY(Replicated)
	int32 Value = 0;
};
`;
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyStruct.h",
    headerText: header,
    sourcePath: null,
    sourceText: null,
    scope: "class",
    pushModel: false,
  });
  assert.deepEqual(plan.files, []);
  assert.ok(plan.advisories.some((a) => a.includes("does not derive") || a.includes("USTRUCT")));
});

test("CRLF files stay CRLF", () => {
  const header = HEADER.replace(/\n/g, "\r\n");
  const source = SOURCE.replace(/\n/g, "\r\n");
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: header,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: source,
    scope: "class",
    pushModel: false,
  });
  for (const file of plan.files) {
    assert.ok(file.edits.every((edit) => !/(?<!\r)\n/.test(edit.text)));
  }
});

test("member scope only touches the caret member", () => {
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MyActor.h",
    headerText: HEADER,
    sourcePath: "/proj/Source/TPSDemo/MyActor.cpp",
    sourceText: SOURCE,
    scope: "member",
    caretHeaderLine: 21,
    pushModel: false,
  });
  const header = applyEdits(HEADER, plan.files.find((f) => f.path.endsWith(".h"))!.edits);
  assert.match(header, /void OnRep_Score\(\);/);
  assert.doesNotMatch(header, /ServerTakeDamage_Implementation/);
  assert.doesNotMatch(header, /MulticastExplode_Implementation/);
  assert.equal(header.match(/OnRep_Score/g)?.length, 2);
});

test("non-networked class generates nothing", () => {
  const header = `#pragma once
#include "CoreMinimal.h"
#include "MyObject.generated.h"

UCLASS()
class UMySettings : public UObject
{
	GENERATED_BODY()

	UPROPERTY(Replicated)
	int32 Value = 0;
};
`;
  const plan = planUnrealNetCodegen({
    headerPath: "/proj/Source/TPSDemo/MySettings.h",
    headerText: header,
    sourcePath: null,
    sourceText: null,
    scope: "class",
    pushModel: false,
  });
  assert.deepEqual(plan.files, []);
  assert.ok(plan.advisories.some((a) => a.includes("does not derive")));
});

test("parsePushModelSetting reads the ini project setting", () => {
  assert.equal(parsePushModelSetting("[SystemSettings]\nnet.IsPushModelEnabled=True\n"), true);
  assert.equal(parsePushModelSetting("net.IsPushModelEnabled=0"), false);
  assert.equal(parsePushModelSetting("; net.IsPushModelEnabled=1"), false);
  assert.equal(parsePushModelSetting("[Other]\nfoo=1"), false);
});
