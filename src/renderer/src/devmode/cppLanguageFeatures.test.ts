import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UE_WORD_DOCS,
  assessCppDefinition,
  isMemberAccessBefore,
  formatCppHoverMarkdown,
  hasSuperQualifierBefore,
  modelUriToPath,
  overlayLiveCppSymbols,
  qualifiedContainerBefore,
  rankCppDefinitions,
  registerCppLanguageFeatures,
} from "./cppLanguageFeatures.js";
import { scanCppIndexSymbols, type CppSymbolEntry } from "./cppSymbolIndex.js";

const ROOT = "E:/Proj";

const HEADER = `${ROOT}/Source/Public/ANFCharacter.h`;
const SOURCE = `${ROOT}/Source/Private/ANFCharacter.cpp`;
const OTHER_H = `${ROOT}/Source/Public/BEnemy.h`;
const OTHER_C = `${ROOT}/Source/Private/BEnemy.cpp`;

const FILES = new Map<string, string>([
  [
    HEADER,
    `#pragma once

UCLASS()
class ANFCharacter : public AActor
{
    GENERATED_BODY()

public:
    ANFCharacter();

    virtual void BeginPlay();

    float TakeDamage(float Damage);

    UPROPERTY(EditAnywhere)
    float Health = 100.f;
};
`,
  ],
  [
    SOURCE,
    `#include "ANFCharacter.h"

void ANFCharacter::BeginPlay()
{
    Super::BeginPlay();
}

float ANFCharacter::TakeDamage(float Damage)
{
    return Damage;
}
`,
  ],
  [
    OTHER_H,
    `#pragma once

class BEnemy
{
public:
    void BeginPlay();
};
`,
  ],
  [
    OTHER_C,
    `#include "BEnemy.h"

void BEnemy::BeginPlay()
{
}
`,
  ],
]);

type SymbolStore = {
  getEntries: (word: string) => CppSymbolEntry[];
  lookupSymbols: (word: string) => Promise<CppSymbolEntry[]>;
};

function makeSymbolStore(files: Map<string, string> = FILES): SymbolStore {
  const entries = [...files].flatMap(([path, text]) => scanCppIndexSymbols(text, path));
  const getEntries = (word: string) =>
    entries.filter((entry) => entry.name.toLowerCase() === word.toLowerCase());
  return { getEntries, lookupSymbols: async (word) => getEntries(word) };
}

function findDefinitions(
  store: SymbolStore,
  lookup: Parameters<typeof rankCppDefinitions>[1],
  options?: { includeCaretLine?: boolean },
): CppSymbolEntry[] {
  return rankCppDefinitions(store.getEntries(lookup.word), lookup, options);
}

test("qualifiedContainerBefore extracts the qualifier chain", () => {
  const text = "void F() { ANFCharacter::BeginPlay(); }";
  const at = text.indexOf("BeginPlay");
  assert.equal(qualifiedContainerBefore(text, at), "ANFCharacter");

  const superCall = "    Super::BeginPlay();";
  assert.equal(qualifiedContainerBefore(superCall, superCall.indexOf("BeginPlay")), null);

  const plain = "  BeginPlay();";
  assert.equal(qualifiedContainerBefore(plain, plain.indexOf("BeginPlay")), null);

  const spaced = "ANFCharacter :: BeginPlay";
  assert.equal(qualifiedContainerBefore(spaced, spaced.indexOf("BeginPlay")), "ANFCharacter");

  const nested = "return NF::Utils::Helper();";
  assert.equal(qualifiedContainerBefore(nested, nested.indexOf("Helper")), "Utils");
});

test("hasSuperQualifierBefore detects the base-class qualifier", () => {
  const superCall = "    Super::BeginPlay();";
  assert.equal(
    hasSuperQualifierBefore(superCall, superCall.indexOf("BeginPlay")),
    true,
  );
  const spaced = "Super :: BeginPlay();";
  assert.equal(hasSuperQualifierBefore(spaced, spaced.indexOf("BeginPlay")), true);
  const owned = "ANFCharacter::BeginPlay();";
  assert.equal(hasSuperQualifierBefore(owned, owned.indexOf("BeginPlay")), false);
  const bare = "    BeginPlay();";
  assert.equal(hasSuperQualifierBefore(bare, bare.indexOf("BeginPlay")), false);
});

test("L2 enclosing container boosts same-class hits without demoting others", () => {
  const entries: CppSymbolEntry[] = [
    { name: "BeginPlay", kind: "function", path: HEADER, line: 37, container: "ANFCharacter" },
    { name: "BeginPlay", kind: "function", path: OTHER_H, line: 6, container: "BEnemy" },
  ];
  const caller = `${ROOT}/Source/Private/Mixed.cpp`;

  const neutral = rankCppDefinitions(entries, {
    word: "BeginPlay",
    currentPath: caller,
  });
  assert.equal(neutral[0]!.path, HEADER);

  const inEnemy = rankCppDefinitions(entries, {
    word: "BeginPlay",
    currentPath: caller,
    enclosingContainer: "BEnemy",
  });
  assert.equal(inEnemy[0]!.path, OTHER_H);
  assert.equal(inEnemy.length, entries.length);

  const unrelated = rankCppDefinitions(entries, {
    word: "BeginPlay",
    currentPath: caller,
    enclosingContainer: "FSomethingElse",
  });
  assert.deepEqual(
    unrelated.map((e) => e.path),
    neutral.map((e) => e.path),
  );

  const qualified = rankCppDefinitions(entries, {
    word: "BeginPlay",
    currentPath: caller,
    qualifiedContainer: "ANFCharacter",
    enclosingContainer: "BEnemy",
  });
  assert.equal(qualified[0]!.path, HEADER);
});

test("resolveDefinition splits identical bare calls by enclosing class (L2)", async () => {
  const MIXED = `${ROOT}/Source/Private/Mixed.cpp`;
  const mixedText = `#include "ANFCharacter.h"
#include "BEnemy.h"

void ANFCharacter::Restart()
{
    BeginPlay();
}

void BEnemy::Patrol()
{
    BeginPlay();
}
`;
  const lines = mixedText.split("\n");
  const callLines: number[] = [];
  lines.forEach((line, i) => {
    if (line.includes("BeginPlay();")) callLines.push(i + 1);
  });
  assert.equal(callLines.length, 2);
  const column = lines[callLines[0]! - 1]!.indexOf("BeginPlay") + 3;

  const { monaco } = fakeMonaco();
  const features = registerCppLanguageFeatures(monaco, {
    lookupSymbols: makeSymbolStore(new Map(FILES)).lookupSymbols,
    getWorkspaceRoot: () => ROOT,
  });
  const model = fakeModel(mixedText, MIXED);

  const inCharacter = await features.resolveDefinition(model, {
    lineNumber: callLines[0]!,
    column,
  });
  assert.equal(inCharacter.reason, "enclosing");
  assert.equal(inCharacter.certain?.path, HEADER);

  const inEnemy = await features.resolveDefinition(model, {
    lineNumber: callLines[1]!,
    column,
  });
  assert.equal(inEnemy.reason, "enclosing");
  assert.equal(inEnemy.certain?.path, OTHER_H);

  features.dispose();
});

test("resolveDefinition treats parameters and locals as certain", async () => {
  const path = `${ROOT}/Source/Private/Locals.cpp`;
  const text = `void ANFCharacter::UseTarget(ANFCharacter* Target)
{
    int32 Count = 1;
    Target->Use(Count);
}
`;
  const lines = text.split("\n");
  const { monaco } = fakeMonaco();
  const features = registerCppLanguageFeatures(monaco, {
    lookupSymbols: async (word) => [
      {
        name: word,
        kind: "variable",
        path: `${ROOT}/Unrelated.h`,
        line: 99,
        container: "Other",
      },
    ],
    getWorkspaceRoot: () => ROOT,
  });
  const model = fakeModel(text, path);
  const useLine = lines.findIndex((line) => line.includes("Target->Use")) + 1;

  const target = await features.resolveDefinition(model, {
    lineNumber: useLine,
    column: lines[useLine - 1]!.indexOf("Target") + 2,
  });
  assert.equal(target.reason, "local");
  assert.deepEqual(target.certain, { path, line: 1 });

  const count = await features.resolveDefinition(model, {
    lineNumber: useLine,
    column: lines[useLine - 1]!.indexOf("Count") + 2,
  });
  assert.equal(count.reason, "local");
  assert.deepEqual(count.certain, { path, line: 3 });
  features.dispose();
});

test("L2 resolves header member declarations to their own class", async () => {
  const headerText = FILES.get(HEADER)!;
  const headerLines = headerText.split("\n");
  const declLine =
    headerLines.findIndex((line) => line.includes("virtual void BeginPlay();")) + 1;
  assert.ok(declLine > 0);
  const column = headerLines[declLine - 1]!.indexOf("BeginPlay") + 3;

  const { monaco } = fakeMonaco();
  const features = registerCppLanguageFeatures(monaco, {
    lookupSymbols: makeSymbolStore(new Map(FILES)).lookupSymbols,
    getWorkspaceRoot: () => ROOT,
  });
  const decision = await features.resolveDefinition(fakeModel(headerText, HEADER), {
    lineNumber: declLine,
    column,
  });
  assert.equal(decision.reason, "enclosing");
  assert.equal(decision.certain?.path, SOURCE);
  const targets = decision.candidates;
  const firstEnemy = targets.findIndex(
    (t) => t.path === OTHER_H || t.path === OTHER_C,
  );
  const lastOwn = targets.reduce(
    (acc, t, i) => (t.path === HEADER || t.path === SOURCE ? i : acc),
    -1,
  );
  assert.ok(firstEnemy === -1 || firstEnemy > lastOwn);
  features.dispose();
});

test("modelUriToPath decodes monaco file URIs", () => {
  assert.equal(
    modelUriToPath({ scheme: "file", path: "/e:/Proj/A.h" }),
    "e:/Proj/A.h",
  );
  assert.equal(
    modelUriToPath({ scheme: "file", path: "/E:/My%20Proj/A.h" }),
    "E:/My Proj/A.h",
  );
  assert.equal(
    modelUriToPath({ scheme: "file", path: "/proj/a.h" }),
    "/proj/a.h",
  );
  assert.equal(modelUriToPath({ scheme: "inmemory", path: "model/1" }), null);
});

test("rankCppDefinitions ranks container matches and prefers decls cross-file", async () => {
  const index = makeSymbolStore();

  const qualified = findDefinitions(index, {
    word: "BeginPlay",
    currentPath: `${ROOT}/Source/Private/Unrelated.cpp`,
    qualifiedContainer: "ANFCharacter",
  });
  assert.equal(qualified[0]!.path, HEADER);
  assert.ok(
    qualified.slice(0, 2).every((e) => e.container === "ANFCharacter"),
    qualified.map((e) => `${e.container}@${e.path}`).join(", "),
  );

  const unqualified = findDefinitions(index, {
    word: "BeginPlay",
    currentPath: `${ROOT}/Source/Private/Unrelated.cpp`,
  });
  assert.equal(unqualified[0]!.path, HEADER);
  assert.ok(unqualified[0]!.container === "ANFCharacter");

  const type = findDefinitions(index, {
    word: "ANFCharacter",
    currentPath: null,
  });
  assert.equal(type[0]!.kind, "class");
  assert.equal(type[0]!.path, HEADER);

  const field = findDefinitions(index, { word: "Health", currentPath: SOURCE });
  assert.equal(field.length, 1);
  assert.equal(field[0]!.kind, "variable");
  assert.equal(field[0]!.container, "ANFCharacter");

  assert.deepEqual(
    findDefinitions(index, { word: "NoSuchSymbol", currentPath: null }),
    [],
  );
});

test("rankCppDefinitions toggles decl↔impl and skips the self location", async () => {
  const index = makeSymbolStore();

  const implLine = FILES.get(SOURCE)!.split(/\r?\n/).findIndex((l) =>
    l.includes("ANFCharacter::BeginPlay"),
  ) + 1;
  const fromImpl = findDefinitions(index, {
    word: "BeginPlay",
    currentPath: SOURCE,
    caretLine: implLine,
  });
  assert.equal(fromImpl[0]!.path, HEADER);
  assert.ok(!fromImpl.some((e) => e.path === SOURCE && e.line === implLine));

  const declLine = FILES.get(HEADER)!.split(/\r?\n/).findIndex((l) =>
    l.includes("virtual void BeginPlay"),
  ) + 1;
  const fromDecl = findDefinitions(index, {
    word: "BeginPlay",
    currentPath: HEADER,
    caretLine: declLine,
  });
  assert.equal(fromDecl[0]!.path, SOURCE);
  assert.equal(fromDecl[0]!.isImpl, true);
});

test("hover on a field declaration keeps that line and shows the type", async () => {
  const header = `${ROOT}/Source/Public/Witness.h`;
  const text = `#pragma once

class AWitness
{
public:
    UPROPERTY()
    TArray<FNotifyWitnessEventParam> ViewerWitnessEventArray;
};
`;
  const files = new Map(FILES);
  files.set(header, text);
  const index = makeSymbolStore(files);
  const lineNo =
    text.split(/\r?\n/).findIndex((line) => line.includes("ViewerWitnessEventArray")) + 1;
  const lookup = {
    word: "ViewerWitnessEventArray",
    currentPath: header,
    caretLine: lineNo,
  };
  assert.equal(findDefinitions(index, lookup).length, 0);

  const kept = findDefinitions(index, lookup, { includeCaretLine: true });
  assert.equal(kept[0]?.kind, "variable");
  assert.equal(kept[0]?.returnType, "TArray<FNotifyWitnessEventParam>");

  const { monaco, hoverProviders } = fakeMonaco();
  registerCppLanguageFeatures(monaco, {
    lookupSymbols: index.lookupSymbols,
    getWorkspaceRoot: () => ROOT,
  });
  const model = fakeModel(text, header);
  const col =
    text.split(/\r?\n/)[lineNo - 1]!.indexOf("ViewerWitnessEventArray") + 2;
  const hover = await (
    hoverProviders[0] as {
      provideHover: (
        m: unknown,
        p: { lineNumber: number; column: number },
      ) => Promise<{ contents: Array<{ value: string }> } | null>;
    }
  ).provideHover(model, { lineNumber: lineNo, column: col });
  assert.ok(hover);
  assert.match(hover!.contents[0]!.value, /TArray<FNotifyWitnessEventParam>/);
  assert.match(hover!.contents[0]!.value, /ViewerWitnessEventArray/);
});

test("formatCppHoverMarkdown renders signature, locations and UE docs", async () => {
  const index = makeSymbolStore();

  const impl = index
    .getEntries("TakeDamage")
    .find((e) => e.isImpl)!;
  const md = formatCppHoverMarkdown(
    "TakeDamage",
    [impl],
    ROOT,
  );
  assert.ok(md!.includes("<h4><em>ƒ</em> TakeDamage</h4>"));
  assert.ok(md!.includes("float ANFCharacter::TakeDamage(float Damage)"));
  assert.ok(md!.includes("<td>Impl</td>"));
  assert.ok(md!.includes('title="Source/Private/ANFCharacter.cpp"'));

  const mdDoc = formatCppHoverMarkdown("UPROPERTY", [], null);
  assert.ok(mdDoc!.includes("UPROPERTY</h4>"));
  assert.ok(mdDoc!.includes(UE_WORD_DOCS.UPROPERTY!));

  assert.equal(formatCppHoverMarkdown("Nothing", [], null), null);

  const decl = index.getEntries("Health")[0]!;
  const fieldMd = formatCppHoverMarkdown("Health", [decl], ROOT);
  assert.ok(fieldMd!.includes("Source/Public/ANFCharacter.h"));
});

test("formatCppHoverMarkdown keeps UE word docs without guessing engine locations", () => {
  const md = formatCppHoverMarkdown("FVector", [], "E:/Proj");
  assert.ok(md!.includes("FVector</h4>"));
  assert.ok(md!.includes(UE_WORD_DOCS.FVector!));
  assert.ok(!md!.includes("Engine/Source"));
});
test("resolveDefinition answers qualified calls and leaves unindexed engine types to clangd", async () => {
  const { monaco } = fakeMonaco();
  const features = registerCppLanguageFeatures(monaco, {
    lookupSymbols: makeSymbolStore(new Map(FILES)).lookupSymbols,
    getWorkspaceRoot: () => ROOT,
  });

  const qualified = await features.resolveDefinition(
    fakeModel("void F() { ANFCharacter::BeginPlay(); }", `${ROOT}/Source/Private/Caller.cpp`),
    { lineNumber: 1, column: 27 },
  );
  assert.equal(qualified.reason, "qualified");
  assert.equal(qualified.certain?.path, HEADER);

  const engine = await features.resolveDefinition(
    fakeModel("FVector V;", `${ROOT}/Source/Private/VectorUser.cpp`),
    { lineNumber: 1, column: 2 },
  );
  assert.equal(engine.certain, null);
  assert.equal(engine.ambiguity, "none");

  const none = await features.resolveDefinition(
    fakeModel("NothingHere;", `${ROOT}/Source/Private/Caller.cpp`),
    { lineNumber: 1, column: 3 },
  );
  assert.equal(none.certain, null);
  assert.equal(none.ambiguity, "none");
  assert.deepEqual(none.candidates, []);

  features.dispose();
});

test("resolveDefinition ranks lookup hits and overlays the unsaved buffer", async () => {
  const index = makeSymbolStore(new Map(FILES));
  const stored = index
    .getEntries("BeginPlay")
    .find((entry) => entry.path === HEADER);
  assert.ok(stored);

  const { monaco } = fakeMonaco();
  const features = registerCppLanguageFeatures(monaco, {
    lookupSymbols: async (word) => index.getEntries(word),
    getWorkspaceRoot: () => ROOT,
  });

  const ranked = await features.resolveDefinition(
    fakeModel(
      "void F() { ANFCharacter::BeginPlay(); }",
      `${ROOT}/Source/Private/Caller.cpp`,
    ),
    { lineNumber: 1, column: 27 },
  );
  assert.equal(ranked.certain?.path, HEADER);
  assert.equal(ranked.certain?.line, stored.line);

  const liveHeader = `\n${FILES.get(HEADER)!}`;
  const liveLines = liveHeader.split("\n");
  const liveLine = liveLines.findIndex((line) => line.includes("BeginPlay")) + 1;
  const liveColumn = liveLines[liveLine - 1]!.indexOf("BeginPlay") + 1;
  assert.notEqual(liveLine, stored.line);
  const merged = overlayLiveCppSymbols(
    index.getEntries("BeginPlay"),
    HEADER,
    liveHeader,
    "BeginPlay",
  );
  assert.equal(
    merged.find((entry) => entry.path === HEADER)?.line,
    liveLine,
  );
  assert.equal(
    merged.some((entry) => entry.path === HEADER && entry.line === stored.line),
    false,
  );
  const overlaid = await features.resolveDefinition(
    fakeModel(liveHeader, HEADER),
    { lineNumber: liveLine, column: liveColumn },
  );
  assert.equal(overlaid.certain?.path, SOURCE);
  assert.equal(
    overlaid.candidates.some((target) => target.path === HEADER && target.line === stored.line),
    false,
  );

  const engine = await features.resolveDefinition(
    fakeModel("FVector V;", `${ROOT}/Source/Private/VectorUser.cpp`),
    { lineNumber: 1, column: 2 },
  );
  assert.equal(engine.certain, null);

  features.dispose();
});


type FakeModel = {
  text: string;
  path: string | null;
  lines: string[];
};

function fakeModel(text: string, path: string | null): FakeModel & {
  getValue(): string;
  getWordAtPosition(p: { lineNumber: number; column: number }): {
    word: string;
    startColumn: number;
    endColumn: number;
  } | null;
  getOffsetAt(p: { lineNumber: number; column: number }): number;
  uri: { scheme: string; path: string };
} {
  const lines = text.split(/\r?\n/);
  const model: FakeModel = { text, path, lines };
  const uriPath = path
    ? `/${path.replace(/\\/g, "/")}`
    : "/model/1";
  return Object.assign(model, {
    getValue: () => text,
    getWordAtPosition(p: { lineNumber: number; column: number }) {
      const line = lines[p.lineNumber - 1] ?? "";
      const col = p.column - 1;
      const m = /[A-Za-z_]\w*/g;
      for (let hit = m.exec(line); hit !== null; hit = m.exec(line)) {
        if (col >= hit.index && col <= hit.index + hit[0].length) {
          return {
            word: hit[0],
            startColumn: hit.index + 1,
            endColumn: hit.index + 1 + hit[0].length,
          };
        }
      }
      return null;
    },
    getOffsetAt(p: { lineNumber: number; column: number }) {
      let offset = 0;
      for (let i = 0; i < p.lineNumber - 1; i++) offset += (lines[i] ?? "").length + 1;
      return offset + p.column - 1;
    },
    uri: { scheme: path ? "file" : "inmemory", path: uriPath },
  });
}

function fakeMonaco() {
  const definitionProviders: unknown[] = [];
  const hoverProviders: unknown[] = [];
  const uris: unknown[] = [];
  const monaco = {
    languages: {
      registerDefinitionProvider: (_id: string, provider: unknown) => {
        definitionProviders.push(provider);
        return { dispose: () => {} };
      },
      registerHoverProvider: (_id: string, provider: unknown) => {
        hoverProviders.push(provider);
        return { dispose: () => {} };
      },
    },
    Uri: {
      file: (path: string) => {
        const uri = { scheme: "file", path: `/${path}`, fsPath: path };
        uris.push(uri);
        return uri;
      },
    },
  };
  return { monaco, definitionProviders, hoverProviders, uris };
}

test("registerCppLanguageFeatures wires providers end to end", async () => {
  const index = makeSymbolStore(new Map(FILES));
  const { monaco, definitionProviders, hoverProviders } = fakeMonaco();
  registerCppLanguageFeatures(monaco, {
    lookupSymbols: index.lookupSymbols,
    getWorkspaceRoot: () => ROOT,
  });
  assert.equal(definitionProviders.length, 1);
  assert.equal(hoverProviders.length, 1);

  const callerText = `#include "ANFCharacter.h"

void TickAlong()
{
    ANFCharacter::BeginPlay();
}
`;
  const callerPath = `${ROOT}/Source/Private/Caller.cpp`;
  const model = fakeModel(callerText, callerPath);
  const lineNo = callerText.split(/\r?\n/).findIndex((l) => l.includes("BeginPlay")) + 1;
  const col = callerText.split(/\r?\n/)[lineNo - 1]!.indexOf("BeginPlay") + 3;

  const def = await (
    definitionProviders[0] as {
      provideDefinition: (
        m: unknown,
        p: { lineNumber: number; column: number },
      ) => Promise<unknown>;
    }
  ).provideDefinition(model, { lineNumber: lineNo, column: col });
  assert.ok(Array.isArray(def));
  const locations = def as Array<{ uri: { fsPath: string }; range: { startLineNumber: number } }>;
  assert.equal(locations[0]!.uri.fsPath, HEADER);
  assert.ok(locations[0]!.range.startLineNumber >= 1);

  const hover = await (
    hoverProviders[0] as {
      provideHover: (
        m: unknown,
        p: { lineNumber: number; column: number },
      ) => Promise<{ contents: Array<{ value: string }> } | null>;
    }
  ).provideHover(model, { lineNumber: lineNo, column: col });
  assert.ok(hover);
  assert.ok(hover!.contents[0]!.value.includes("BeginPlay</h4>"));

  const noRoot = fakeMonaco();
  registerCppLanguageFeatures(noRoot.monaco, {
    lookupSymbols: makeSymbolStore().lookupSymbols,
    getWorkspaceRoot: () => null,
  });
  const none = await (
    noRoot.definitionProviders[0] as {
      provideDefinition: (
        m: unknown,
        p: { lineNumber: number; column: number },
      ) => Promise<unknown>;
    }
  ).provideDefinition(model, { lineNumber: lineNo, column: col });
  assert.equal(none, null);
});

test("definition provider sends unindexed engine types to clangd", async () => {
  const MATH_FWD = "E:/UE/Engine/Source/Runtime/Core/Public/Math/MathFwd.h";
  const index = makeSymbolStore(new Map(FILES));
  const { monaco, definitionProviders, hoverProviders } = fakeMonaco();
  registerCppLanguageFeatures(monaco, {
    lookupSymbols: index.lookupSymbols,
    getWorkspaceRoot: () => ROOT,
    getSemanticDefinition: async () => [{ path: MATH_FWD, line: 42 }],
  });

  assert.equal(findDefinitions(index, { word: "FVector", currentPath: null }).length, 0);

  const text = "FVector Origin = FVector::ZeroVector;\n";
  const model = fakeModel(text, `${ROOT}/Source/Private/VectorUser.cpp`);
  const def = await (
    definitionProviders[0] as {
      provideDefinition: (
        m: unknown,
        p: { lineNumber: number; column: number },
      ) => Promise<unknown>;
    }
  ).provideDefinition(model, { lineNumber: 1, column: 2 });
  assert.ok(Array.isArray(def));
  const locations = def as Array<{ uri: { fsPath: string }; range: { startLineNumber: number } }>;
  assert.equal(locations.length, 1);
  assert.equal(locations[0]!.uri.fsPath, MATH_FWD);
  assert.equal(locations[0]!.range.startLineNumber, 42);

  const hover = await (
    hoverProviders[0] as {
      provideHover: (
        m: unknown,
        p: { lineNumber: number; column: number },
      ) => Promise<{ contents: Array<{ value: string }> } | null>;
    }
  ).provideHover(model, { lineNumber: 1, column: 2 });
  assert.ok(hover);
  assert.ok(hover!.contents[0]!.value.includes(UE_WORD_DOCS.FVector!));
  assert.ok(!hover!.contents[0]!.value.includes("Engine/Source"));

  const wsDef = await (
    definitionProviders[0] as {
      provideDefinition: (
        m: unknown,
        p: { lineNumber: number; column: number },
      ) => Promise<unknown>;
    }
  ).provideDefinition(
    fakeModel("void F() { ANFCharacter::BeginPlay(); }", SOURCE),
    { lineNumber: 1, column: 27 },
  );
  const wsLocations = wsDef as Array<{ uri: { fsPath: string } }>;
  assert.equal(wsLocations[0]!.uri.fsPath, HEADER);
  assert.ok(
    wsLocations.every((l) => !l.uri.fsPath.includes("/Engine/Source/")),
  );
});

const fn = (
  name: string,
  path: string,
  line: number,
  extra: Partial<CppSymbolEntry> = {},
): CppSymbolEntry => ({ name, kind: "function", path, line, ...extra });

test("assessCppDefinition is certain only for one unambiguous symbol", () => {
  const caller = `${ROOT}/Source/Private/Caller.cpp`;
  const decl = fn("Tick", HEADER, 10, { container: "ANFCharacter", params: "float Dt" });
  const impl = fn("Tick", SOURCE, 20, { container: "ANFCharacter", params: "float Dt", isImpl: true });
  const enemy = fn("Tick", OTHER_H, 5, { container: "BEnemy", params: "float Dt" });
  const lookup = { word: "Tick", currentPath: caller };

  const unique = assessCppDefinition({ entries: [decl, impl], lookup, memberAccess: false });
  assert.equal(unique.reason, "unique");
  assert.deepEqual(unique.certain, { path: HEADER, line: 10 });

  const bare = assessCppDefinition({ entries: [decl, impl, enemy], lookup, memberAccess: false });
  assert.equal(bare.certain, null);
  assert.equal(bare.ambiguity, "multiple");

  const viaMember = assessCppDefinition({ entries: [decl, impl, enemy], lookup, memberAccess: true });
  assert.equal(viaMember.ambiguity, "member-access");
  const singleMember = assessCppDefinition({ entries: [decl, impl], lookup, memberAccess: true });
  assert.equal(singleMember.reason, "unique");

  const qualified = assessCppDefinition({
    entries: [decl, impl, enemy],
    lookup: { ...lookup, qualifiedContainer: "BEnemy" },
    memberAccess: false,
  });
  assert.equal(qualified.reason, "qualified");
  assert.deepEqual(qualified.certain, { path: OTHER_H, line: 5 });

  const missing = assessCppDefinition({
    entries: [decl, impl],
    lookup: { ...lookup, qualifiedContainer: "UOther" },
    memberAccess: false,
  });
  assert.equal(missing.ambiguity, "unmatched-qualifier");

  const enclosing = assessCppDefinition({
    entries: [decl, impl, enemy],
    lookup: { ...lookup, enclosingContainer: "BEnemy" },
    memberAccess: false,
  });
  assert.equal(enclosing.reason, "enclosing");
});

test("assessCppDefinition defers overloads, duplicate types and case-only matches", () => {
  const lookup = { word: "Fire", currentPath: `${ROOT}/x.cpp` };
  const overloads = assessCppDefinition({
    entries: [
      fn("Fire", HEADER, 3, { container: "AGun", params: "" }),
      fn("Fire", HEADER, 4, { container: "AGun", params: "int32 Count" }),
    ],
    lookup,
    memberAccess: false,
  });
  assert.equal(overloads.ambiguity, "overloaded");

  const twoImpls = assessCppDefinition({
    entries: [
      fn("Fire", SOURCE, 3, { container: "AGun", isImpl: true }),
      fn("Fire", OTHER_C, 9, { container: "AGun", isImpl: true }),
    ],
    lookup,
    memberAccess: false,
  });
  assert.equal(twoImpls.ambiguity, "overloaded");

  const forwardDecls = assessCppDefinition({
    entries: [
      { name: "AGun", kind: "class", path: HEADER, line: 1 },
      { name: "AGun", kind: "struct", path: OTHER_H, line: 2 },
    ],
    lookup: { word: "AGun", currentPath: null },
    memberAccess: false,
  });
  assert.equal(forwardDecls.ambiguity, "multiple");

  const caseOnly = assessCppDefinition({
    entries: [fn("fire", HEADER, 1)],
    lookup,
    memberAccess: false,
  });
  assert.equal(caseOnly.ambiguity, "none");

  const generatedOnly = assessCppDefinition({
    entries: [
      fn("Fire", `${ROOT}/Intermediate/Inc/Game/UHT/Gun.gen.cpp`, 40, { container: "AGun", isImpl: true }),
      fn("Fire", HEADER, 3, { container: "AGun" }),
    ],
    lookup,
    memberAccess: false,
  });
  assert.deepEqual(generatedOnly.certain, { path: HEADER, line: 3 });
});

test("isMemberAccessBefore spots receivers but not this->", () => {
  const at = (text: string) => isMemberAccessBefore(text, text.length);
  assert.equal(at("Enemy->"), true);
  assert.equal(at("GetOwner()->"), true);
  assert.equal(at("Items[0]."), true);
  assert.equal(at("Stats."), true);
  assert.equal(at("this->"), false);
  assert.equal(at("ANFCharacter::"), false);
  assert.equal(at("    "), false);
});

test("the definition provider defers ambiguous symbols to clangd", async () => {
  const MIXED = `${ROOT}/Source/Private/Free.cpp`;
  const text = "void Free()\n{\n    BeginPlay();\n}\n";
  const semantic: Array<{ path: string; line: number }> = [{ path: OTHER_C, line: 3 }];
  let semanticCalls = 0;
  const { monaco, definitionProviders } = fakeMonaco();
  registerCppLanguageFeatures(monaco, {
    lookupSymbols: makeSymbolStore(new Map(FILES)).lookupSymbols,
    getWorkspaceRoot: () => ROOT,
    getSemanticDefinition: async () => {
      semanticCalls++;
      return semantic.length > 0 ? semantic : null;
    },
  });
  const provider = definitionProviders[0] as {
    provideDefinition: (
      m: unknown,
      p: { lineNumber: number; column: number },
    ) => Promise<Array<{ uri: { fsPath: string }; range: { startLineNumber: number } }> | null>;
  };
  const model = fakeModel(text, MIXED);
  const position = { lineNumber: 3, column: text.split("\n")[2]!.indexOf("BeginPlay") + 2 };

  const deferred = await provider.provideDefinition(model, position);
  assert.equal(semanticCalls, 1);
  assert.equal(deferred?.[0]?.uri.fsPath, OTHER_C);
  assert.equal(deferred?.[0]?.range.startLineNumber, 3);

  semantic.length = 0;
  assert.equal(await provider.provideDefinition(model, position), null);

  const qualifiedModel = fakeModel("void F() { ANFCharacter::BeginPlay(); }", MIXED);
  const certain = await provider.provideDefinition(qualifiedModel, { lineNumber: 1, column: 27 });
  assert.equal(certain?.[0]?.uri.fsPath, HEADER);
  assert.equal(semanticCalls, 2);
});
