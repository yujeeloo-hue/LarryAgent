import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  toTsCompletionItems,
  toTsLocations,
  toTsResolvedCompletion,
  tsIdentifierPrefixAt,
  tsUriToPath,
} from "./convert.js";

const abs = (name: string) => join(resolve("/G"), name).replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

test("file URIs become paths with an upper-case Windows drive", () => {
  if (process.platform === "win32") {
    assert.equal(tsUriToPath("file:///c%3A/Game/src/a.ts"), "C:\\Game\\src\\a.ts");
  } else {
    assert.equal(tsUriToPath("file:///Users/me/app/a.ts"), "/Users/me/app/a.ts");
  }
  assert.equal(tsUriToPath("untitled:Untitled-1"), null);
});

test("the identifier prefix includes $ and private # names", () => {
  assert.equal(tsIdentifierPrefixAt("const v = $sto", 1, 15), "$sto");
  assert.equal(tsIdentifierPrefixAt("x\n  this.#cou", 2, 13), "#cou");
  assert.equal(tsIdentifierPrefixAt("foo.", 1, 5), "");
});

test("completion keeps the server edit range, auto-import edits and a resolve id", () => {
  const raw = {
    isIncomplete: false,
    items: [
      {
        label: "ORIGIN",
        kind: 21,
        sortText: "16",
        textEdit: { range: range(2, 8, 10), newText: "ORIGIN" },
        additionalTextEdits: [{ range: range(0, 0, 0), newText: "import { ORIGIN } from \"./math\";\n" }],
        documentation: { kind: "markdown", value: "Origin point" },
      },
      { label: "Object", kind: 7, insertText: "Object" },
      { label: "addVec", kind: 3, insertText: "addVec($1)", insertTextFormat: 2, detail: "function" },
    ],
  };
  const { items, isIncomplete } = toTsCompletionItems(raw, "O", "7");
  assert.equal(isIncomplete, false);
  assert.deepEqual(items, [
    {
      label: "ORIGIN",
      kind: 21,
      insertText: "ORIGIN",
      isSnippet: false,
      range: { startLine: 3, startColumn: 9, endLine: 3, endColumn: 11 },
      documentation: "Origin point",
      sortText: "16",
      additionalEdits: [
        { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, text: "import { ORIGIN } from \"./math\";\n" },
      ],
      resolveId: "7:0",
    },
    { label: "Object", kind: 7, insertText: "Object", isSnippet: false, resolveId: "7:1" },
  ]);
  const snippet = toTsCompletionItems(raw, "", null).items[2];
  assert.equal(snippet?.isSnippet, true);
  assert.equal(snippet?.resolveId, undefined);
});

test("completion beyond the limit is cut and reported incomplete", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ label: `item${i}` }));
  const result = toTsCompletionItems(items, "", "1", 3);
  assert.equal(result.items.length, 3);
  assert.equal(result.isIncomplete, true);
  assert.equal(toTsCompletionItems({ isIncomplete: true, items }, "", "1").isIncomplete, true);
});

test("a resolved item contributes detail, docs and import edits only", () => {
  assert.deepEqual(
    toTsResolvedCompletion({
      label: "addVec",
      detail: "function addVec(a: Vec, b: Vec): Vec",
      documentation: "Adds two vectors.",
      additionalTextEdits: [{ range: range(0, 0, 0), newText: "import { addVec } from \"./math\";\n" }],
    }),
    {
      detail: "function addVec(a: Vec, b: Vec): Vec",
      documentation: "Adds two vectors.",
      additionalEdits: [
        { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, text: "import { addVec } from \"./math\";\n" },
      ],
    },
  );
  assert.deepEqual(toTsResolvedCompletion(null), {});
});

test("locations accept Location, LocationLink and single results", () => {
  assert.deepEqual(
    toTsLocations([
      { uri: pathToFileURL(abs("a.ts")).href, range: range(4, 2, 8) },
      { targetUri: pathToFileURL(abs("b.ts")).href, targetRange: range(0, 0, 9), targetSelectionRange: range(1, 13, 19) },
      { uri: pathToFileURL(abs("c.ts")).href },
    ]),
    [
      { path: abs("a.ts"), line: 5, column: 3 },
      { path: abs("b.ts"), line: 2, column: 14 },
    ],
  );
  assert.deepEqual(toTsLocations({ uri: pathToFileURL(abs("d.ts")).href, range: range(0, 0, 1) }), [
    { path: abs("d.ts"), line: 1, column: 1 },
  ]);
  assert.deepEqual(toTsLocations(null), []);
});
