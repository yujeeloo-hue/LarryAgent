import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baseCppTypeName,
  filterCppUsageCandidates,
  type CppLocalBindingLike,
} from "./cppFindUsages.js";
import {
  cppContainerElementType,
  inferAutoReturnTypes,
} from "./FindUsagesController.js";

const local: CppLocalBindingLike = {
  kind: "parameter",
  name: "Target",
  type: "ANFCharacter*",
  declarationLine: 1,
  declarationColumn: 23,
  scope: { startLine: 1, startColumn: 1, endLine: 4, endColumn: 1 },
  functionRange: { startLine: 1, startColumn: 1, endLine: 4, endColumn: 1 },
};

describe("cppFindUsages", () => {
  it("normalizes common Unreal pointer wrappers", () => {
    assert.equal(baseCppTypeName("const TObjectPtr<ANFCharacter>&"), "ANFCharacter");
    assert.equal(baseCppTypeName("ANFCharacter *"), "ANFCharacter");
  });

  it("keeps only candidates bound to the selected local", () => {
    const text =
      "void F(ANFCharacter* Target) {\n  Target->Run();\n  Other(Target);\n}\n";
    const candidates = [
      { path: "A.cpp", line: 1, column: 23, lineText: "void F(ANFCharacter* Target) {" },
      { path: "A.cpp", line: 2, column: 3, lineText: "Target->Run();" },
      { path: "A.cpp", line: 3, column: 9, lineText: "Other(Target);" },
    ];
    const resolve = (
      _text: string,
      _line: number,
      _column: number,
      word: string,
    ) => (word === "Target" ? local : null);
    const rows = filterCppUsageCandidates(
      { kind: "local", word: "Target", path: "A.cpp", text, binding: local },
      candidates,
      new Map([["A.cpp", text]]),
      resolve,
    );
    assert.deepEqual(rows.map((row) => row.line), [2, 3]);
  });

  it("uses a parameter receiver type to disambiguate member calls", () => {
    const text =
      "void AOther::F(ANFCharacter* Target) {\n  Target->Run();\n  Run();\n}\n";
    const entries = [
      {
        name: "Run",
        kind: "function" as const,
        path: "NFCharacter.h",
        line: 10,
        container: "ANFCharacter",
      },
    ];
    const candidates = [
      { path: "A.cpp", line: 2, column: 11, lineText: "Target->Run();" },
      { path: "A.cpp", line: 3, column: 3, lineText: "Run();" },
    ];
    const rows = filterCppUsageCandidates(
      {
        kind: "symbol",
        word: "Run",
        entries,
        primary: entries[0]!,
      },
      candidates,
      new Map([["A.cpp", text]]),
      (_source, _line, _column, word) => (word === "Target" ? local : null),
    );
    assert.deepEqual(rows.map((row) => row.line), [2]);
  });

  it("uses symbol-table inference for an auto receiver", () => {
    const text =
      "void AOther::F() {\n  auto Target = MakeCharacter();\n  Target->Run();\n}\n";
    const autoBinding: CppLocalBindingLike = {
      kind: "local",
      name: "Target",
      type: "auto",
      initializerCall: { name: "MakeCharacter" },
      declarationLine: 2,
      declarationColumn: 8,
      scope: { startLine: 1, startColumn: 1, endLine: 4, endColumn: 1 },
      functionRange: { startLine: 1, startColumn: 1, endLine: 4, endColumn: 1 },
    };
    const entry = {
      name: "Run",
      kind: "function" as const,
      path: "NFCharacter.h",
      line: 10,
      container: "ANFCharacter",
    };
    const rows = filterCppUsageCandidates(
      { kind: "symbol", word: "Run", entries: [entry], primary: entry },
      [{ path: "A.cpp", line: 3, column: 11, lineText: "Target->Run();" }],
      new Map([["A.cpp", text]]),
      (_source, _line, _column, word) =>
        word === "Target" ? autoBinding : null,
      [],
      new Map([["A.cpp:2:8", "ANFCharacter*"]]),
    );
    assert.equal(rows.length, 1);
  });

  it("infers auto receiver types from unique function returns", async () => {
    const text =
      "void AOther::F() {\n  auto Target = MakeCharacter();\n  Target->Run();\n}\n";
    const inferred = await inferAutoReturnTypes(
      [{ path: "A.cpp", line: 3, column: 11, lineText: "Target->Run();" }],
      new Map([["A.cpp", text]]),
      async (word) =>
        word === "MakeCharacter"
          ? [
              {
                name: word,
                kind: "function",
                path: "Factory.h",
                line: 2,
                returnType: "ANFCharacter*",
              },
            ]
          : [],
    );
    assert.equal(inferred.get("A.cpp:2:8"), "ANFCharacter*");
  });

  it("extracts range element types from Unreal containers", () => {
    assert.equal(cppContainerElementType("const TArray<ANFCharacter*>&"), "ANFCharacter*");
    assert.equal(
      cppContainerElementType("TMap<FName, TObjectPtr<ANFCharacter>>"),
      "TPair<FName, TObjectPtr<ANFCharacter>>",
    );
  });

  it("infers auto range bindings from an explicitly typed local container", async () => {
    const text =
      "void AOther::F() {\n  TArray<ANFCharacter*> Targets;\n  for (auto* Target : Targets) {\n    Target->Run();\n  }\n}\n";
    const inferred = await inferAutoReturnTypes(
      [{ path: "A.cpp", line: 4, column: 13, lineText: "Target->Run();" }],
      new Map([["A.cpp", text]]),
      async () => [],
    );
    assert.equal(inferred.get("A.cpp:3:14"), "ANFCharacter*");
  });
});
