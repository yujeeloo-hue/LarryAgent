import assert from "node:assert/strict";
import { test } from "node:test";

import { UnrealNetCodegenController } from "./unrealNetCodegenController.js";
import type { NetCodegenEdit } from "./unrealNetCodegen.js";

function applyEdits(text: string, edits: readonly NetCodegenEdit[]): string {
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

const HEADER = `#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "MyActor.generated.h"

UCLASS()
class AMyActor : public AActor
{
	GENERATED_BODY()

	UPROPERTY(Replicated)
	int32 Health = 0;
};
`;

const SOURCE = `#include "MyActor.h"

AMyActor::AMyActor()
{
	bReplicates = true;
}
`;

const HEADER_PATH = "/proj/Source/Game/Private/MyActor.h";
const SOURCE_PATH = "/proj/Source/Game/Private/MyActor.cpp";

type Harness = {
  controller: UnrealNetCodegenController;
  files: Map<string, string>;
  notices: string[];
  editsApplied: { path: string; count: number }[];
};

function harness(options?: {
  header?: string;
  source?: string;
  ini?: string | null;
  activePath?: string;
}): Harness {
  const files = new Map<string, string>([
    [HEADER_PATH, options?.header ?? HEADER],
    [SOURCE_PATH, options?.source ?? SOURCE],
  ]);
  const notices: string[] = [];
  const editsApplied: { path: string; count: number }[] = [];
  const ini = options?.ini ?? null;
  const controller = new UnrealNetCodegenController({
    getActiveDocument: () => {
      const path = options?.activePath ?? HEADER_PATH;
      const text = files.get(path);
      return text === undefined ? null : { path, text, line: 12 };
    },
    resolveCounterpart: async (path) =>
      path === HEADER_PATH ? SOURCE_PATH : HEADER_PATH,
    ensureOpen: async () => undefined,
    getDocumentText: (path) => files.get(path) ?? null,
    applyEdits: (path, edits) => {
      const text = files.get(path);
      if (text === undefined) return false;
      files.set(path, applyEdits(text, edits));
      editsApplied.push({ path, count: edits.length });
      return true;
    },
    activate: () => undefined,
    notice: (message) => notices.push(message),
    workspaceRoot: () => "/proj",
    readTextFile: async (path) =>
      path === "/proj/Config/DefaultEngine.ini" ? ini : null,
  });
  return { controller, files, notices, editsApplied };
}

test("generates declarations, definition and registration from the header", async () => {
  const h = harness();
  await h.controller.run();
  const header = h.files.get(HEADER_PATH)!;
  const source = h.files.get(SOURCE_PATH)!;
  assert.match(
    header,
    /virtual void GetLifetimeReplicatedProps\(TArray<FLifetimeProperty>& OutLifetimeProps\) const override;/,
  );
  assert.match(
    source,
    /void AMyActor::GetLifetimeReplicatedProps\(TArray<FLifetimeProperty>& OutLifetimeProps\) const/,
  );
  assert.match(source, /DOREPLIFETIME\(AMyActor, Health\);/);
  assert.match(source, /#include "Net\/UnrealNetwork\.h"/);
  assert.equal(h.editsApplied.length, 2);
  assert.ok(h.notices.at(-1)?.includes("added"));
});

test("a second run applies nothing and says so", async () => {
  const h = harness();
  await h.controller.run();
  const before = h.notices.length;
  h.editsApplied.length = 0;
  await h.controller.run();
  assert.equal(h.editsApplied.length, 0);
  assert.ok(h.notices.length > before);
  assert.ok(h.notices.at(-1)?.includes("already present"));
});

test("runs from the source tab too", async () => {
  const h = harness({ activePath: SOURCE_PATH });
  await h.controller.run();
  const source = h.files.get(SOURCE_PATH)!;
  assert.match(source, /DOREPLIFETIME\(AMyActor, Health\);/);
  assert.ok(h.notices.at(-1)?.includes("added"));
});

test("push model setting in DefaultEngine.ini drives the macro choice", async () => {
  const header = HEADER.replace(
    "\tUPROPERTY(Replicated)\n\tint32 Health = 0;",
    "\tUPROPERTY(Replicated)\n\tint32 Health = 0;\n\n\tvoid SetHealth(int32 InValue);",
  );
  const source = `${SOURCE}
void AMyActor::SetHealth(int32 InValue)
{
	Health = InValue;
}
`;
  const h = harness({ header, source, ini: "[SystemSettings]\nnet.IsPushModelEnabled=True\n" });
  await h.controller.run();
  const out = h.files.get(SOURCE_PATH)!;
  assert.match(out, /#include "Net\/Core\/PushModel\/PushModel\.h"/);
  assert.match(out, /FDoRepLifetimeParams Params;/);
  assert.match(out, /DOREPLIFETIME_WITH_PARAMS_FAST\(AMyActor, Health, Params\);/);
  assert.match(out, /MARK_PROPERTY_DIRTY_FROM_NAME\(AMyActor, Health, this\);/);
});

test("a non-C++ file is refused without edits", async () => {
  const files = new Map<string, string>([
    ["/proj/readme.md", "# hi"],
  ]);
  const notices: string[] = [];
  const controller = new UnrealNetCodegenController({
    getActiveDocument: () => ({
      path: "/proj/readme.md",
      text: files.get("/proj/readme.md")!,
      line: 1,
    }),
    resolveCounterpart: async () => null,
    ensureOpen: async () => undefined,
    getDocumentText: (path) => files.get(path) ?? null,
    applyEdits: () => false,
    activate: () => undefined,
    notice: (message) => notices.push(message),
    workspaceRoot: () => "/proj",
    readTextFile: async () => null,
  });
  await controller.run();
  assert.ok(notices.at(-1)?.includes("Not a C++ file"));
});
