/**
 * Quick Open ranking — ordering rules, engine demotion, and the incremental
 * cursor, which must never change what a full sweep would have produced.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendRankTier,
  buildRankTier,
  fuzzyMatch,
  rankFiles,
  rankSymbols,
  type RankFile,
  type RankSymbol,
} from "./quickOpenRank.js";

const project = (rels: string[]): RankFile[] =>
  rels.map((rel) => ({ rel, path: `/ws/${rel}` }));

const engine = (rels: string[]): RankFile[] =>
  rels.map((rel) => ({ rel, path: `/engine/${rel.slice("Engine/".length)}` }));

const relsOf = (files: RankFile[]): string[] => files.map((f) => f.rel);

describe("fuzzyMatch", () => {
  it("empty query matches everything", () => {
    assert.equal(fuzzyMatch("", "anything.ts"), true);
  });

  it("case-insensitive subsequence across the target", () => {
    assert.equal(fuzzyMatch("eac", "EditorAreaController.ts"), true);
  });

  it("out-of-order characters do not match", () => {
    assert.equal(fuzzyMatch("cae", "EditorAreaController.ts"), false);
  });
});

describe("rankFiles ordering", () => {
  it("exact basename beats prefix, substring, path, then fuzzy", () => {
    const tier = buildRankTier(
      project([
        "src/zzz/fuzz/a/c/t/o/r.ts", // fuzzy only
        "src/actor/Thing.ts", // path substring
        "src/MyActorThing.ts", // basename substring
        "src/ActorThing.ts", // basename prefix
        "src/Actor.ts", // exact basename
      ]),
      false,
    );
    assert.deepEqual(relsOf(rankFiles([tier], "actor", 10).files), [
      "src/Actor.ts",
      "src/ActorThing.ts",
      "src/MyActorThing.ts",
      "src/actor/Thing.ts",
      "src/zzz/fuzz/a/c/t/o/r.ts",
    ]);
  });

  it("an exact basename match still requires the whole basename", () => {
    const tier = buildRankTier(project(["a/Actor.ts", "b/Actor.tsx"]), false);
    // Actor.tsx is a prefix match, not exact — shorter path loses to quality.
    assert.deepEqual(relsOf(rankFiles([tier], "actor.ts", 10).files), [
      "a/Actor.ts",
      "b/Actor.tsx",
    ]);
  });

  it("ties break on path length, then lexicographically", () => {
    const tier = buildRankTier(
      project(["zz/Actor.ts", "ab/Actor.ts", "deep/er/Actor.ts"]),
      false,
    );
    assert.deepEqual(relsOf(rankFiles([tier], "actor.ts", 10).files), [
      "ab/Actor.ts",
      "zz/Actor.ts",
      "deep/er/Actor.ts",
    ]);
  });

  it("demoted engine files rank below project files of equal quality", () => {
    const tiers = [
      buildRankTier(project(["Source/Widget.h"]), false),
      buildRankTier(engine(["Engine/Source/Widget.h"]), true),
    ];
    assert.deepEqual(relsOf(rankFiles(tiers, "widget", 10).files), [
      "Source/Widget.h",
      "Engine/Source/Widget.h",
    ]);
  });

  it("quality outranks tier while project wins equal-quality ties", () => {
    const tiers = [
      buildRankTier(project(["src/w/i/d/g/e/t/x.h"]), false),
      buildRankTier(engine(["Engine/Widget.h"]), true),
    ];
    assert.deepEqual(relsOf(rankFiles(tiers, "widget.h", 10).files), [
      "Engine/Widget.h",
      "src/w/i/d/g/e/t/x.h",
    ]);
  });

  it("engineOnly narrows to the engine tier", () => {
    const engineTier = buildRankTier(
      engine(["Engine/Source/Widget.h", "Engine/Misc/Other.h"]),
      true,
    );
    assert.deepEqual(relsOf(rankFiles([engineTier], "widget", 10).files), [
      "Engine/Source/Widget.h",
    ]);
  });

  it("limit caps the rows but total counts every match", () => {
    const tier = buildRankTier(
      project(["a/Actor.ts", "b/Actor.ts", "c/Actor.ts"]),
      false,
    );
    const result = rankFiles([tier], "actor", 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.total, 3);
  });

  it("non-matching files are excluded entirely", () => {
    const tier = buildRankTier(project(["src/Actor.ts", "src/Other.ts"]), false);
    assert.deepEqual(relsOf(rankFiles([tier], "zzq", 10).files), []);
  });
});

describe("rankFiles incremental cursor", () => {
  const tiers = [
    buildRankTier(
      project([
        "src/Editor.ts",
        "src/EditorArea.ts",
        "src/EditorAreaController.ts",
        "src/edit/Thing.ts",
        "src/Unrelated.ts",
        "src/e/d/i/t/o/r.ts",
      ]),
      false,
    ),
    buildRankTier(engine(["Engine/Source/Editor.cpp", "Engine/Misc/Edit.h"]), true),
  ];

  it("an extending query reuses candidates without changing results", () => {
    const wide = rankFiles(tiers, "e", 50);
    const narrowed = rankFiles(tiers, "edi", 50, wide.cursor);
    const fresh = rankFiles(tiers, "edi", 50);
    assert.deepEqual(relsOf(narrowed.files), relsOf(fresh.files));
    assert.equal(narrowed.total, fresh.total);
  });

  it("stays correct across a chain of keystrokes", () => {
    let cursor = rankFiles(tiers, "e", 50).cursor;
    for (const query of ["ed", "edi", "edit", "edito", "editor"]) {
      const stepped = rankFiles(tiers, query, 50, cursor);
      const fresh = rankFiles(tiers, query, 50);
      assert.deepEqual(relsOf(stepped.files), relsOf(fresh.files), query);
      cursor = stepped.cursor;
    }
  });

  it("a shortened query cannot reuse the narrower candidate set", () => {
    const narrow = rankFiles(tiers, "editor", 50);
    const widened = rankFiles(tiers, "ed", 50, narrow.cursor);
    const fresh = rankFiles(tiers, "ed", 50);
    assert.deepEqual(relsOf(widened.files), relsOf(fresh.files));
  });

  it("a cursor from different tiers is ignored", () => {
    const other = [buildRankTier(project(["src/Editor.ts"]), false)];
    const stale = rankFiles(other, "e", 50).cursor;
    const result = rankFiles(tiers, "ed", 50, stale);
    assert.deepEqual(relsOf(result.files), relsOf(rankFiles(tiers, "ed", 50).files));
  });
});

describe("appendRankTier", () => {
  it("extends the tier and invalidates cursor reuse by identity", () => {
    const first = buildRankTier(engine(["Engine/A/Widget.h"]), true);
    const grown = appendRankTier(first, engine(["Engine/B/Widget.h"]));
    assert.notEqual(grown, first);
    assert.deepEqual(relsOf(rankFiles([grown], "widget", 10).files), [
      "Engine/A/Widget.h",
      "Engine/B/Widget.h",
    ]);
  });

  it("streamed batches match a single up-front build", () => {
    const all = engine([
      "Engine/Source/Widget.h",
      "Engine/Source/WidgetTree.h",
      "Engine/Misc/OtherWidget.h",
    ]);
    let streamed = buildRankTier([], true);
    for (const file of all) streamed = appendRankTier(streamed, [file]);
    const atOnce = buildRankTier(all, true);
    assert.deepEqual(
      relsOf(rankFiles([streamed], "widget", 10).files),
      relsOf(rankFiles([atOnce], "widget", 10).files),
    );
  });
});

const sym = (
  name: string,
  rel: string,
  kind = "function",
  container?: string,
): RankSymbol => {
  const entry: RankSymbol = {
    name,
    path: `/ws/${rel}`,
    rel,
    line: 1,
    symbolKind: kind,
  };
  if (container) entry.container = container;
  return entry;
};

describe("rankSymbols", () => {
  it("exact function name beats prefix, substring, then fuzzy", () => {
    const ranked = rankSymbols(
      [
        sym("Txick", "a.ts"),
        sym("OnTick", "b.ts"),
        sym("TickInternal", "c.ts"),
        sym("Tick", "d.ts"),
      ],
      "tick",
      10,
    );
    assert.deepEqual(
      ranked.map((s) => s.name),
      ["Tick", "TickInternal", "OnTick", "Txick"],
    );
  });

  it("functions sort ahead of types at equal name quality", () => {
    const ranked = rankSymbols(
      [sym("BeginPlay", "Actor.h", "class"), sym("BeginPlay", "Actor.cpp")],
      "BeginPlay",
      10,
    );
    assert.deepEqual(
      ranked.map((s) => `${s.symbolKind}:${s.rel}`),
      ["function:Actor.cpp", "class:Actor.h"],
    );
  });

  it("does not match names that fail the subsequence test", () => {
    assert.deepEqual(
      rankSymbols([sym("BeginPlay", "Actor.h")], "xyz", 10),
      [],
    );
  });
});

