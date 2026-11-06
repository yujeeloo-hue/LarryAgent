import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UE_WORD_DOCS,
  findCppDefinitions,
  findUeEngineDeclLine,
  formatCppHoverMarkdown,
  hasSuperQualifierBefore,
  modelUriToPath,
  overlayLiveCppSymbols,
  qualifiedContainerBefore,
  rankCppDefinitions,
  registerCppLanguageFeatures,
  resolveUeEngineTypeLocation,
} from "./cppLanguageFeatures.js";
import { CppWorkspaceIndex, type CppSymbolEntry } from "./cppSymbolIndex.js";

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

function makeIndex(files: Map<string, string> = FILES): CppWorkspaceIndex {
  return new CppWorkspaceIndex({
    listCppFiles: async () => [...files.keys()],
    readTextFile: async (path) => files.get(path) ?? null,
  });
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

  // No context at all: alphabetical path order decides (ANFCharacter.h first).
  const neutral = rankCppDefinitions(entries, {
    word: "BeginPlay",
    currentPath: caller,
  });
  assert.equal(neutral[0]!.path, HEADER);

  // Caret inside BEnemy → its member wins, and nothing was dropped.
  const inEnemy = rankCppDefinitions(entries, {
    word: "BeginPlay",
    currentPath: caller,
    enclosingContainer: "BEnemy",
  });
  assert.equal(inEnemy[0]!.path, OTHER_H);
  assert.equal(inEnemy.length, entries.length);

  // Boost-only: an unrelated enclosing class must not reorder the baseline.
  const unrelated = rankCppDefinitions(entries, {
    word: "BeginPlay",
    currentPath: caller,
    enclosingContainer: "FSomethingElse",
  });
  assert.deepEqual(
    unrelated.map((e) => e.path),
    neutral.map((e) => e.path),
  );

  // A spelled-out qualifier still wins over the enclosing class.
  const qualified = rankCppDefinitions(entries, {
    word: "BeginPlay",
    currentPath: caller,
    qualifiedContainer: "ANFCharacter",
    enclosingContainer: "BEnemy",
  });
  assert.equal(qualified[0]!.path, HEADER);
});

test("gotoDefinition splits identical bare calls by enclosing class (L2)", async () => {
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
    index: makeIndex(new Map(FILES)),
    getWorkspaceRoot: () => ROOT,
  });
  const model = fakeModel(mixedText, MIXED);

  // Same word, same file, same column — only the enclosing class differs.
  const inCharacter = await features.gotoDefinition(model, {
    lineNumber: callLines[0]!,
    column,
  });
  assert.ok(inCharacter && inCharacter.length > 0);
  assert.equal(inCharacter[0]!.path, HEADER);

  const inEnemy = await features.gotoDefinition(model, {
    lineNumber: callLines[1]!,
    column,
  });
  assert.ok(inEnemy && inEnemy.length > 0);
  assert.equal(inEnemy[0]!.path, OTHER_H);

  features.dispose();
});

test("gotoDefinition prefers parameter and local declarations", async () => {
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

  const target = await features.gotoDefinition(model, {
    lineNumber: useLine,
    column: lines[useLine - 1]!.indexOf("Target") + 2,
  });
  assert.equal(target?.[0]?.path, path);
  assert.equal(target?.[0]?.line, 1);

  const count = await features.gotoDefinition(model, {
    lineNumber: useLine,
    column: lines[useLine - 1]!.indexOf("Count") + 2,
  });
  assert.equal(count?.[0]?.path, path);
  assert.equal(count?.[0]?.line, 3);

  const usageTarget = await features.resolveUsageTarget(model, {
    lineNumber: useLine,
    column: lines[useLine - 1]!.indexOf("Count") + 2,
  });
  assert.equal(usageTarget?.kind, "local");
  if (usageTarget?.kind === "local") {
    assert.equal(usageTarget.binding.declarationLine, 3);
  }
  features.dispose();
});

test("L2 resolves header member declarations to their own class", async () => {
  // Caret on the `BeginPlay` declaration inside ANFCharacter.h: the L2
  // container is ANFCharacter, so the jump lands on that class's impl —
  // never BEnemy's identically named method.
  const headerText = FILES.get(HEADER)!;
  const headerLines = headerText.split("\n");
  const declLine =
    headerLines.findIndex((line) => line.includes("virtual void BeginPlay();")) + 1;
  assert.ok(declLine > 0);
  const column = headerLines[declLine - 1]!.indexOf("BeginPlay") + 3;

  const { monaco } = fakeMonaco();
  const features = registerCppLanguageFeatures(monaco, {
    index: makeIndex(new Map(FILES)),
    getWorkspaceRoot: () => ROOT,
  });
  const targets = await features.gotoDefinition(fakeModel(headerText, HEADER), {
    lineNumber: declLine,
    column,
  });
  assert.ok(targets && targets.length > 0);
  // Top target: this class's implementation (decl↔impl toggle).
  assert.equal(targets[0]!.path, SOURCE);
  // BEnemy's identically named method stays in the peek list (Alt+F12) but
  // must rank below both ANFCharacter locations.
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

test("findCppDefinitions ranks container matches and prefers decls cross-file", async () => {
  const index = makeIndex();
  await index.ensure(ROOT);

  // Qualified call from a third-party file: ANFCharacter::BeginPlay wins.
  const qualified = findCppDefinitions(index, {
    word: "BeginPlay",
    currentPath: `${ROOT}/Source/Private/Unrelated.cpp`,
    qualifiedContainer: "ANFCharacter",
  });
  assert.equal(qualified[0]!.path, HEADER);
  assert.ok(
    qualified.slice(0, 2).every((e) => e.container === "ANFCharacter"),
    qualified.map((e) => `${e.container}@${e.path}`).join(", "),
  );

  // Unqualified from another source: the declaration is the stable landing.
  const unqualified = findCppDefinitions(index, {
    word: "BeginPlay",
    currentPath: `${ROOT}/Source/Private/Unrelated.cpp`,
  });
  assert.equal(unqualified[0]!.path, HEADER);
  assert.ok(unqualified[0]!.container === "ANFCharacter");

  // Type-looking word: the class outranks same-named constructors.
  const type = findCppDefinitions(index, {
    word: "ANFCharacter",
    currentPath: null,
  });
  assert.equal(type[0]!.kind, "class");
  assert.equal(type[0]!.path, HEADER);

  // Fields resolve.
  const field = findCppDefinitions(index, { word: "Health", currentPath: SOURCE });
  assert.equal(field.length, 1);
  assert.equal(field[0]!.kind, "variable");
  assert.equal(field[0]!.container, "ANFCharacter");

  // Unknown symbol → empty.
  assert.deepEqual(
    findCppDefinitions(index, { word: "NoSuchSymbol", currentPath: null }),
    [],
  );
});

test("findCppDefinitions toggles decl↔impl and skips the self location", async () => {
  const index = makeIndex();
  await index.ensure(ROOT);

  // Caret sitting on the impl in SOURCE: jump to the declaration.
  const implLine = FILES.get(SOURCE)!.split(/\r?\n/).findIndex((l) =>
    l.includes("ANFCharacter::BeginPlay"),
  ) + 1;
  const fromImpl = findCppDefinitions(index, {
    word: "BeginPlay",
    currentPath: SOURCE,
    caretLine: implLine,
  });
  assert.equal(fromImpl[0]!.path, HEADER);
  assert.ok(!fromImpl.some((e) => e.path === SOURCE && e.line === implLine));

  // Caret on the decl in HEADER: prefer the implementation.
  const declLine = FILES.get(HEADER)!.split(/\r?\n/).findIndex((l) =>
    l.includes("virtual void BeginPlay"),
  ) + 1;
  const fromDecl = findCppDefinitions(index, {
    word: "BeginPlay",
    currentPath: HEADER,
    caretLine: declLine,
  });
  assert.equal(fromDecl[0]!.path, SOURCE);
  assert.equal(fromDecl[0]!.isImpl, true);
});

test("formatCppHoverMarkdown renders signature, locations and UE docs", async () => {
  const index = makeIndex();
  await index.ensure(ROOT);

  const impl = index
    .getEntries("TakeDamage")
    .find((e) => e.isImpl)!;
  const md = formatCppHoverMarkdown(
    "TakeDamage",
    [impl],
    ROOT,
  );
  assert.ok(md!.includes("**ANFCharacter::TakeDamage**"));
  assert.ok(md!.includes("`float TakeDamage(float Damage)`"));
  assert.ok(md!.includes(`Impl \`Source/Private/ANFCharacter.cpp`));

  const mdDoc = formatCppHoverMarkdown("UPROPERTY", [], null);
  assert.ok(mdDoc!.includes("**UPROPERTY**"));
  assert.ok(mdDoc!.includes(UE_WORD_DOCS.UPROPERTY!));

  assert.equal(formatCppHoverMarkdown("Nothing", [], null), null);

  // Root-relative path rendering.
  const decl = index.getEntries("Health")[0]!;
  const fieldMd = formatCppHoverMarkdown("Health", [decl], ROOT);
  assert.ok(fieldMd!.includes("Source/Public/ANFCharacter.h"));
});

test("resolveUeEngineTypeLocation maps engine types to headers", async () => {
  const ENGINE = "E:/UE/Engine";
  const VECTOR_H = `${ENGINE}/Source/Runtime/Core/Public/Math/Vector.h`;
  const engineFiles = new Map<string, string>([
    [
      VECTOR_H,
      `#pragma once

struct TVector
{
};

using FVector = TVector<double>;
`,
    ],
    [
      `${ENGINE}/Source/Runtime/Engine/Classes/GameFramework/Actor.h`,
      `class ENGINE_API AActor : public UObject
{
};
`,
    ],
  ]);

  // FVector → Vector.h, declaration line found (the `using` line).
  const fv = await resolveUeEngineTypeLocation(
    "FVector",
    ENGINE,
    async (p) => engineFiles.get(p) ?? null,
  );
  assert.ok(fv, "FVector resolved");
  assert.equal(fv!.path, VECTOR_H);
  assert.equal(fv!.line, 7);

  // AActor → Actor.h, class line found.
  const actor = await resolveUeEngineTypeLocation(
    "AActor",
    ENGINE,
    async (p) => engineFiles.get(p) ?? null,
  );
  assert.ok(actor);
  assert.equal(actor!.path, `${ENGINE}/Source/Runtime/Engine/Classes/GameFramework/Actor.h`);
  assert.equal(actor!.line, 1);

  // Unknown word / no engine root / unreadable candidates → null.
  assert.equal(
    await resolveUeEngineTypeLocation("NotAThing", ENGINE, async () => "x"),
    null,
  );
  assert.equal(
    await resolveUeEngineTypeLocation("FVector", null, async () => "x"),
    null,
  );
  assert.equal(
    await resolveUeEngineTypeLocation("FVector", ENGINE, async () => null),
    null,
  );

  // Candidate fallback: first candidate missing → second one wins.
  const second = await resolveUeEngineTypeLocation(
    "FName",
    ENGINE,
    async (p) =>
      p.endsWith("Misc/NameTypes.h") ? "struct FName {};" : null,
  );
  assert.ok(second);
  assert.ok(second!.path.endsWith("Misc/NameTypes.h"));

  // Cache: second resolve must not re-read.
  let reads = 0;
  const cached = new Map();
  const readOnce = async (p: string) => {
    reads += 1;
    return p.endsWith("Math/Vector.h") ? "using FVector = X;" : null;
  };
  await resolveUeEngineTypeLocation("FVector", ENGINE, readOnce, cached);
  await resolveUeEngineTypeLocation("FVector", ENGINE, readOnce, cached);
  assert.equal(reads, 1);
});

test("findUeEngineDeclLine matches struct/class/enum/using/typedef", () => {
  const text = [
    "struct FPlain {};",
    "class  ENGINE_API  FApi : public FPlain {};",
    "enum class EThing : uint8 {};",
    "using FAlias = FPlain;",
    "typedef FPlain FTypedef;",
  ].join("\n");
  assert.equal(findUeEngineDeclLine(text, "FPlain"), 1);
  assert.equal(findUeEngineDeclLine(text, "FApi"), 2);
  assert.equal(findUeEngineDeclLine(text, "EThing"), 3);
  assert.equal(findUeEngineDeclLine(text, "FAlias"), 4);
  assert.equal(findUeEngineDeclLine(text, "FTypedef"), 5);
  // No match → line 1 (open the header at the top).
  assert.equal(findUeEngineDeclLine(text, "Missing"), 1);
  // Must not match substrings or parameter usages.
  assert.equal(
    findUeEngineDeclLine("void F(const FVector& V);\nstruct FVector {};", "FVector"),
    2,
  );
});

test("formatCppHoverMarkdown renders engine source locations", () => {
  const md = formatCppHoverMarkdown("FVector", [], "E:/Proj", {
    path: "E:/UE/Engine/Source/Runtime/Core/Public/Math/Vector.h",
    line: 7,
  });
  assert.ok(md!.includes("**FVector**"));
  assert.ok(
    md!.includes("Engine `Engine/Source/Runtime/Core/Public/Math/Vector.h:7`"),
  );
  assert.ok(md!.includes(UE_WORD_DOCS.FVector!));
});

test("gotoDefinition returns ranked targets and engine fallback", async () => {
  const ENGINE = "E:/UE/Engine";
  const VECTOR_H = `${ENGINE}/Source/Runtime/Core/Public/Math/Vector.h`;
  const engineFiles = new Map([[VECTOR_H, "using FVector = TVector<double>;\n"]]);

  const { monaco } = fakeMonaco();
  const features = registerCppLanguageFeatures(monaco, {
    index: makeIndex(new Map(FILES)),
    getWorkspaceRoot: () => ROOT,
    getEngineRoot: async () => ENGINE,
    readEngineTextFile: async (p) => engineFiles.get(p) ?? null,
  });

  // Workspace symbol: ranked list, best target first.
  const targets = await features.gotoDefinition(
    fakeModel("void F() { ANFCharacter::BeginPlay(); }", `${ROOT}/Source/Private/Caller.cpp`),
    { lineNumber: 1, column: 27 },
  );
  assert.ok(targets && targets.length > 0);
  assert.equal(targets[0]!.path, HEADER);

  // Engine type with no workspace declaration: direct engine header target.
  const engine = await features.gotoDefinition(
    fakeModel("FVector V;", `${ROOT}/Source/Private/VectorUser.cpp`),
    { lineNumber: 1, column: 2 },
  );
  assert.deepEqual(engine, [{ path: VECTOR_H, line: 1 }]);

  // Unknown word → [] (caller decides the fallback UX).
  const none = await features.gotoDefinition(
    fakeModel("NothingHere;", `${ROOT}/Source/Private/Caller.cpp`),
    { lineNumber: 1, column: 3 },
  );
  assert.deepEqual(none, []);

  features.dispose();
});

test("gotoDefinition ranks lookup hits and overlays the unsaved buffer", async () => {
  const ENGINE = "E:/UE/Engine";
  const VECTOR_H = `${ENGINE}/Source/Runtime/Core/Public/Math/Vector.h`;
  const engineFiles = new Map([[VECTOR_H, "using FVector = TVector<double>;\n"]]);
  const index = makeIndex(new Map(FILES));
  await index.ensure(ROOT);
  const stored = index
    .getEntries("BeginPlay")
    .find((entry) => entry.path === HEADER);
  assert.ok(stored);

  const { monaco } = fakeMonaco();
  const features = registerCppLanguageFeatures(monaco, {
    lookupSymbols: async (word) => index.getEntries(word),
    getWorkspaceRoot: () => ROOT,
    getEngineRoot: async () => ENGINE,
    readEngineTextFile: async (p) => engineFiles.get(p) ?? null,
  });

  const ranked = await features.gotoDefinition(
    fakeModel(
      "void F() { ANFCharacter::BeginPlay(); }",
      `${ROOT}/Source/Private/Caller.cpp`,
    ),
    { lineNumber: 1, column: 27 },
  );
  assert.ok(ranked && ranked.length > 0);
  assert.equal(ranked[0]!.path, HEADER);
  assert.equal(ranked[0]!.line, stored.line);

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
  const overlaid = await features.gotoDefinition(
    fakeModel(liveHeader, HEADER),
    { lineNumber: liveLine, column: liveColumn },
  );
  assert.ok(overlaid && overlaid.length > 0);
  assert.equal(overlaid[0]!.path, SOURCE);
  assert.equal(
    overlaid.some((target) => target.path === HEADER && target.line === stored.line),
    false,
  );

  const engine = await features.gotoDefinition(
    fakeModel("FVector V;", `${ROOT}/Source/Private/VectorUser.cpp`),
    { lineNumber: 1, column: 2 },
  );
  assert.deepEqual(engine, [{ path: VECTOR_H, line: 1 }]);

  features.dispose();
});

// ------------------------------------------------------------ fake monaco

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
  const index = makeIndex(new Map(FILES));
  const { monaco, definitionProviders, hoverProviders } = fakeMonaco();
  registerCppLanguageFeatures(monaco, {
    index,
    getWorkspaceRoot: () => ROOT,
  });
  assert.equal(definitionProviders.length, 1);
  assert.equal(hoverProviders.length, 1);

  // Caller file: cursor on `BeginPlay` inside ANFCharacter::BeginPlay() call.
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
  assert.ok(hover!.contents[0]!.value.includes("**ANFCharacter::BeginPlay**"));

  // No workspace root → definition provider bails out.
  const noRoot = fakeMonaco();
  registerCppLanguageFeatures(noRoot.monaco, {
    index: makeIndex(),
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

test("definition provider falls back to engine headers for engine types", async () => {
  const ENGINE = "E:/UE/Engine";
  const VECTOR_H = `${ENGINE}/Source/Runtime/Core/Public/Math/Vector.h`;
  const engineFiles = new Map([[VECTOR_H, "struct FVector {};\n"]]);

  const index = makeIndex(new Map(FILES));
  const { monaco, definitionProviders, hoverProviders } = fakeMonaco();
  registerCppLanguageFeatures(monaco, {
    index,
    getWorkspaceRoot: () => ROOT,
    getEngineRoot: async () => ENGINE,
    readEngineTextFile: async (p) => engineFiles.get(p) ?? null,
  });

  // `FVector` is not declared anywhere in the workspace…
  assert.equal(findCppDefinitions(index, { word: "FVector", currentPath: null }).length, 0);

  // …so F12 lands on the engine header instead of "no definition".
  // (Own file path: the live-buffer upsert must not clobber ANFCharacter.h.)
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
  assert.equal(locations[0]!.uri.fsPath, VECTOR_H);
  assert.equal(locations[0]!.range.startLineNumber, 1);

  // Hover shows the engine location alongside the UE cheat-sheet line.
  const hover = await (
    hoverProviders[0] as {
      provideHover: (
        m: unknown,
        p: { lineNumber: number; column: number },
      ) => Promise<{ contents: Array<{ value: string }> } | null>;
    }
  ).provideHover(model, { lineNumber: 1, column: 2 });
  assert.ok(hover);
  assert.ok(hover!.contents[0]!.value.includes("Engine/Source/Runtime/Core/Public/Math/Vector.h"));

  // Workspace-declared words keep using the index, not the engine map.
  // (The live single-line buffer replaces SOURCE's impl entries, so the
  // stable landing is the header declaration — never the engine map.)
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
