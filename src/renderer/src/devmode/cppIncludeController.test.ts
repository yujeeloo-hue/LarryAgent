import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addIncludeForSymbolAtCaret,
  pickIncludeHeader,
  type CppIncludeDeps,
  type CppIncludeSymbolHit,
} from "./cppIncludeController.js";
import type { IncludeInsertion } from "../../../shared/cppIncludes.js";

const HEADER = "E:/NF/Source/NF/Public/NFCharacter.h";
const ENGINE_HEADER = "E:/NF/Engine/Source/Runtime/Engine/Public/Components/StaticMeshComponent.h";
const DIRS = ["E:/NF/Source/NF/Public", "E:/NF/Engine/Source/Runtime/Engine/Public"];

function harness(overrides: Partial<CppIncludeDeps> & { hits?: CppIncludeSymbolHit[] } = {}) {
  const notices: string[] = [];
  const applied: { path: string; insertion: IncludeInsertion }[] = [];
  const deps: CppIncludeDeps = {
    workspaceRoot: () => "E:/NF",
    activeDocument: () => ({
      path: "E:/NF/Source/NF/Private/NFActor.cpp",
      text: ['#include "NFActor.h"', "", "void ANFActor::BeginPlay() {}"].join("\n"),
    }),
    symbolAtCaret: () => "UStaticMeshComponent",
    lookupSymbols: async () => overrides.hits ?? [],
    includeDirs: async () => DIRS,
    applyInsertion: (path, insertion) => {
      applied.push({ path, insertion });
      return true;
    },
    notice: (message) => {
      notices.push(message);
    },
    ...overrides,
  };
  return { deps, notices, applied };
}

describe("pickIncludeHeader", () => {
  it("prefers a type declared in a plain header over an implementation file", () => {
    const picked = pickIncludeHeader(
      [
        { name: "ANFActor", kind: "function", path: "E:/NF/Source/NF/Private/NFActor.cpp", line: 10 },
        { name: "ANFActor", kind: "class", path: "E:/NF/Source/NF/Public/NFActor.h", line: 20 },
      ],
      "ANFActor",
      "E:/NF/Source/NF/Private/Other.cpp",
    );
    assert.equal(picked?.path, "E:/NF/Source/NF/Public/NFActor.h");
  });

  it("skips generated headers and the edited file itself", () => {
    const picked = pickIncludeHeader(
      [
        { name: "UThing", kind: "class", path: "E:/NF/Source/NF/Public/Thing.generated.h", line: 1 },
        { name: "UThing", kind: "class", path: "E:/NF/Source/NF/Public/Thing.h", line: 1 },
      ],
      "UThing",
      "E:/NF/Source/NF/Public/Thing.h",
    );
    assert.equal(picked, null, "the only real header is the open file");

    assert.equal(
      pickIncludeHeader(
        [{ name: "UThing", kind: "class", path: "E:/NF/Source/NF/Public/Thing.generated.h", line: 1 }],
        "UThing",
        "E:/NF/Source/NF/Private/Other.cpp",
      ),
      null,
    );
  });
});

describe("addIncludeForSymbolAtCaret", () => {
  it("inserts the include after the existing include block", async () => {
    const { deps, notices, applied } = harness({
      hits: [
        { name: "UStaticMeshComponent", kind: "class", path: ENGINE_HEADER, line: 12 },
        { name: "UStaticMeshComponent", kind: "function", path: "E:/NF/Engine/Private/SMC.cpp", line: 5 },
      ],
    });
    assert.equal(await addIncludeForSymbolAtCaret(deps), true);
    assert.deepEqual(applied, [
      {
        path: "E:/NF/Source/NF/Private/NFActor.cpp",
        insertion: { line: 2, text: '#include "Components/StaticMeshComponent.h"\n' },
      },
    ]);
    assert.deepEqual(notices, ['Added #include "Components/StaticMeshComponent.h"']);
  });

  it("falls back to clangd's index for engine types the text index lacks", async () => {
    const asked: string[] = [];
    const { deps, applied } = harness({
      hits: [],
      lookupIndexSymbols: async (_root, word) => {
        asked.push(word);
        return [
          { name: "UStaticMeshComponent", kind: "function", path: "E:/NF/Engine/Private/SMC.cpp", line: 5 },
          { name: "UStaticMeshComponent", kind: "class", path: ENGINE_HEADER, line: 12 },
        ];
      },
    });
    assert.equal(await addIncludeForSymbolAtCaret(deps), true);
    assert.deepEqual(asked, ["UStaticMeshComponent"]);
    assert.equal(applied[0]?.insertion.text, '#include "Components/StaticMeshComponent.h"\n');

    const projectHit = harness({
      hits: [{ name: "UStaticMeshComponent", kind: "class", path: ENGINE_HEADER, line: 12 }],
      lookupIndexSymbols: async () => {
        throw new Error("must not be asked");
      },
    });
    assert.equal(await addIncludeForSymbolAtCaret(projectHit.deps), true);
  });

  it("logs one trace per run with the notice it showed", async () => {
    const entries: Record<string, unknown>[] = [];
    const { deps } = harness({
      hits: [{ name: "UStaticMeshComponent", kind: "class", path: ENGINE_HEADER, line: 12 }],
      includeDirs: async () => [],
      log: (entry) => entries.push(entry),
    });
    assert.equal(await addIncludeForSymbolAtCaret(deps), false);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ok, false);
    assert.equal(entries[0]?.header, ENGINE_HEADER);
    assert.equal(entries[0]?.includeDirCount, 0);
    assert.match(String(entries[0]?.notice), /No include path/);
  });

  it("does nothing when the header is already included", async () => {
    const { deps, notices, applied } = harness({
      hits: [{ name: "UStaticMeshComponent", kind: "class", path: ENGINE_HEADER, line: 12 }],
      activeDocument: () => ({
        path: "E:/NF/Source/NF/Private/NFActor.cpp",
        text: '#include "Components/StaticMeshComponent.h"\n',
      }),
    });
    assert.equal(await addIncludeForSymbolAtCaret(deps), false);
    assert.deepEqual(applied, []);
    assert.match(notices[0] ?? "", /already there/);
  });

  it("explains the failures instead of editing", async () => {
    const noSymbol = harness({ symbolAtCaret: () => null });
    assert.equal(await addIncludeForSymbolAtCaret(noSymbol.deps), false);
    assert.match(noSymbol.notices[0] ?? "", /caret/);

    const notCpp = harness({ activeDocument: () => ({ path: "E:/NF/README.md", text: "" }) });
    assert.equal(await addIncludeForSymbolAtCaret(notCpp.deps), false);
    assert.match(notCpp.notices[0] ?? "", /Not a C\+\+ file/);

    const noRoot = harness({ workspaceRoot: () => null });
    assert.equal(await addIncludeForSymbolAtCaret(noRoot.deps), false);
    assert.match(noRoot.notices[0] ?? "", /workspace/);

    const noHeader = harness({ hits: [] });
    assert.equal(await addIncludeForSymbolAtCaret(noHeader.deps), false);
    assert.match(noHeader.notices[0] ?? "", /No header declares/);

    const noDirs = harness({
      hits: [{ name: "UStaticMeshComponent", kind: "class", path: ENGINE_HEADER, line: 12 }],
      includeDirs: async () => [],
    });
    assert.equal(await addIncludeForSymbolAtCaret(noDirs.deps), false);
    assert.match(noDirs.notices[0] ?? "", /No include path/);
    assert.deepEqual(noDirs.applied, []);
  });

  it("survives a failing index lookup", async () => {
    const { deps, notices } = harness({
      lookupSymbols: async () => {
        throw new Error("index offline");
      },
    });
    assert.equal(await addIncludeForSymbolAtCaret(deps), false);
    assert.match(notices[0] ?? "", /No header declares/);
  });
});
