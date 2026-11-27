import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeQuickOpenLayers,
  quickOpenEntryKey,
  quickOpenGroupLabel,
  type QuickOpenEntry,
  type QuickOpenLayers,
} from "./quickOpenMerge.js";

const ROOT = "E:/Proj";

const layers = (partial: Partial<QuickOpenLayers>): QuickOpenLayers => ({
  semantic: [],
  index: [],
  text: [],
  files: [],
  ...partial,
});

const label = (entry: QuickOpenEntry): string => {
  if (entry.kind === "file") return `file:${entry.rel}`;
  if (entry.kind === "text") return `text:${entry.rel}:${entry.line}`;
  return `${entry.source}:${entry.name}`;
};

const symbol = (name: string, path: string, line: number, symbolKind = "function") => ({
  name,
  path,
  rel: path.slice(ROOT.length + 1),
  line,
  symbolKind,
});

test("layers merge in precedence order: clangd, index, text, files", () => {
  const merged = mergeQuickOpenLayers({
    query: "hero",
    category: "All",
    layers: layers({
      files: [{ path: `${ROOT}/Source/Hero.h`, rel: "Source/Hero.h" }],
      text: [{ path: `${ROOT}/Docs/notes.md`, rel: "Docs/notes.md", line: 3, column: 1, preview: "hero notes" }],
      index: [symbol("HeroIndex", `${ROOT}/Source/Hero.h`, 20)],
      semantic: [symbol("Hero", `${ROOT}/Source/Hero.h`, 10, "class")],
    }),
  });
  assert.deepEqual(merged.map(label), [
    "semantic:Hero",
    "index:HeroIndex",
    "text:Docs/notes.md:3",
    "file:Source/Hero.h",
  ]);
  assert.deepEqual(merged.map(quickOpenGroupLabel), ["Semantic", "Symbols", "Text", "Files"]);
});

test("lower layers drop hits already located by a more precise layer", () => {
  const merged = mergeQuickOpenLayers({
    query: "jump",
    category: "All",
    layers: layers({
      semantic: [symbol("Jump", `${ROOT}/Source/Hero.cpp`, 12)],
      index: [
        symbol("Jump", "e:\\Proj\\Source\\Hero.cpp", 12),
        symbol("JumpHigher", `${ROOT}/Source/Hero.cpp`, 30),
      ],
      text: [
        { path: `${ROOT}/Source/Hero.cpp`, rel: "Source/Hero.cpp", line: 12, column: 6, preview: "void Jump()" },
        { path: `${ROOT}/Source/Hero.cpp`, rel: "Source/Hero.cpp", line: 30, column: 6, preview: "void JumpHigher()" },
        { path: `${ROOT}/Source/Hero.cpp`, rel: "Source/Hero.cpp", line: 44, column: 3, preview: "Jump();" },
      ],
    }),
  });
  assert.deepEqual(merged.map(label), [
    "semantic:Jump",
    "index:JumpHigher",
    "text:Source/Hero.cpp:44",
  ]);
});

test("categories pick their layers and types stay first inside a layer", () => {
  const input = layers({
    semantic: [symbol("WidgetTick", `${ROOT}/a.cpp`, 1), symbol("Widget", `${ROOT}/a.h`, 2, "class")],
    index: [symbol("WidgetData", `${ROOT}/b.h`, 3, "struct")],
    text: [{ path: `${ROOT}/c.txt`, rel: "c.txt", line: 1, column: 1, preview: "widget" }],
    files: [{ path: `${ROOT}/Widget.h`, rel: "Widget.h" }],
  });
  const of = (category: Parameters<typeof mergeQuickOpenLayers>[0]["category"]) =>
    mergeQuickOpenLayers({ query: "widget", category, layers: input }).map(label);
  assert.deepEqual(of("All"), [
    "semantic:Widget",
    "semantic:WidgetTick",
    "index:WidgetData",
    "text:c.txt:1",
    "file:Widget.h",
  ]);
  assert.deepEqual(of("Types"), ["semantic:Widget", "index:WidgetData"]);
  assert.deepEqual(of("Symbols"), ["semantic:WidgetTick"]);
  assert.deepEqual(of("Text"), ["text:c.txt:1"]);
  assert.deepEqual(of("Files"), ["file:Widget.h"]);
});

test("limits cap each layer and the symbol budget is shared, clangd first", () => {
  const semantic = Array.from({ length: 3 }, (_, i) => symbol(`Sem${i}`, `${ROOT}/s.cpp`, i + 1));
  const index = Array.from({ length: 5 }, (_, i) => symbol(`Sem${i}x`, `${ROOT}/i.cpp`, i + 1));
  const text = Array.from({ length: 6 }, (_, i) => ({
    path: `${ROOT}/t.txt`,
    rel: "t.txt",
    line: i + 1,
    column: 1,
    preview: "sem",
  }));
  const files = Array.from({ length: 6 }, (_, i) => ({ path: `${ROOT}/f${i}.h`, rel: `f${i}.h` }));
  const limits = { symbols: 4, text: 2, textOnly: 5, files: 3 };
  const all = mergeQuickOpenLayers({ query: "sem", category: "All", limits, layers: layers({ semantic, index, text, files }) });
  assert.equal(all.filter((e) => e.kind === "symbol" && e.source === "semantic").length, 3);
  assert.equal(all.filter((e) => e.kind === "symbol" && e.source === "index").length, 1);
  assert.equal(all.filter((e) => e.kind === "text").length, 2);
  assert.equal(all.filter((e) => e.kind === "file").length, 3);
  const textOnly = mergeQuickOpenLayers({ query: "sem", category: "Text", limits, layers: layers({ text }) });
  assert.equal(textOnly.length, 5);
});

test("keepSymbol filters both symbol layers before ranking", () => {
  const merged = mergeQuickOpenLayers({
    query: "actor",
    category: "All",
    keepSymbol: (entry) => entry.path.startsWith(ROOT),
    layers: layers({
      semantic: [symbol("Actor", "D:/UE/Engine/Actor.h", 1, "class"), symbol("ActorHelper", `${ROOT}/x.h`, 2)],
      index: [symbol("ActorTwo", "D:/UE/Engine/Two.h", 3)],
    }),
  });
  assert.deepEqual(merged.map(label), ["semantic:ActorHelper"]);
  assert.equal(
    quickOpenEntryKey({ kind: "text", path: "p", rel: "p", line: 2, column: 5, preview: "" }),
    "text|p|2|5",
  );
});
