import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  fuzzyMatches,
  identifierPrefixAt,
  luaHoverMarkdown,
  readSemanticLegend,
  remapSemanticTokens,
  toLuaCompletionItems,
  toLuaLocations,
} from "./convert.js";

test("semantic tokens are remapped to the client legend and dropped tokens keep later positions right", () => {
  const server = { tokenTypes: ["variable", "class", "method", "keyword"], tokenModifiers: ["declaration", "readonly"] };
  const client = { tokenTypes: ["method", "class"], tokenModifiers: ["readonly", "declaration"] };
  const raw = {
    data: [
      0, 0, 5, 1, 0b01,
      0, 6, 3, 0, 0,
      0, 4, 4, 2, 0b10,
      2, 3, 2, 3, 0,
      0, 4, 6, 2, 0b11,
    ],
  };
  assert.deepEqual(remapSemanticTokens(raw, server, client), [
    0, 0, 5, 1, 0b10,
    0, 10, 4, 0, 0b01,
    2, 7, 6, 0, 0b11,
  ]);
  assert.deepEqual(remapSemanticTokens(null, server, client), []);
});

test("the server legend is read from initialize capabilities", () => {
  assert.deepEqual(
    readSemanticLegend({ semanticTokensProvider: { legend: { tokenTypes: ["class", 3], tokenModifiers: ["static"] } } }),
    { tokenTypes: ["class"], tokenModifiers: ["static"] },
  );
  assert.equal(readSemanticLegend({}), null);
  assert.equal(readSemanticLegend(null), null);
});

test("identifier prefix is read up to the cursor column", () => {
  const text = "local a = 1\n    self.BtnH\n";
  assert.equal(identifierPrefixAt(text, 2, 14), "BtnH");
  assert.equal(identifierPrefixAt(text, 2, 10), "");
  assert.equal(identifierPrefixAt(text, 9, 1), "");
});

test("fuzzy matching is a case-insensitive subsequence", () => {
  assert.ok(fuzzyMatches("GetActorLocation", "gal"));
  assert.ok(fuzzyMatches("anything", ""));
  assert.ok(!fuzzyMatches("BtnHide", "hb"));
});

test("completion items keep insert text, snippets and docs; non-matches are dropped", () => {
  const raw = {
    isIncomplete: false,
    items: [
      { label: "BtnHide", kind: 5, detail: "UMoreButton", documentation: { kind: "markdown", value: "doc" } },
      { label: "Cache", kind: 2, insertText: "Cache()", insertTextFormat: 2 },
      { label: "Other", kind: 5, textEdit: { newText: "Other", range: {} } },
      { label: "", kind: 5 },
    ],
  };
  const { items, isIncomplete } = toLuaCompletionItems(raw, "c");
  assert.equal(isIncomplete, false);
  assert.deepEqual(items, [{ label: "Cache", kind: 2, insertText: "Cache()", isSnippet: true }]);
  const all = toLuaCompletionItems(raw, "");
  assert.deepEqual(all.items[0], {
    label: "BtnHide", kind: 5, insertText: "BtnHide", isSnippet: false, detail: "UMoreButton", documentation: "doc",
  });
  assert.equal(all.items[2]?.insertText, "Other");
});

test("large completion lists are capped and marked incomplete", () => {
  const raw = Array.from({ length: 30 }, (_, i) => ({ label: `A${i}`, kind: 7 }));
  const capped = toLuaCompletionItems(raw, "", 10);
  assert.equal(capped.items.length, 10);
  assert.equal(capped.isIncomplete, true);
  assert.equal(toLuaCompletionItems({ isIncomplete: true, items: [] }, "").isIncomplete, true);
});

test("hover contents of every LSP shape become markdown", () => {
  assert.equal(luaHoverMarkdown({ contents: { kind: "markdown", value: "**x**" } }), "**x**");
  assert.equal(luaHoverMarkdown({ contents: [{ language: "lua", value: "local x" }, "note"] }), "```lua\nlocal x\n```\n\nnote");
  assert.equal(luaHoverMarkdown({ contents: "" }), null);
  assert.equal(luaHoverMarkdown(null), null);
});

test("locations and location links map to 1-based file positions", () => {
  const file = resolve(join("/ws", "Battle", "NFModeVisual.lua"));
  const uri = pathToFileURL(file).href;
  assert.deepEqual(toLuaLocations([{ uri, range: { start: { line: 0, character: 10 } } }]), [
    { path: file, line: 1, column: 11 },
  ]);
  assert.deepEqual(toLuaLocations({ targetUri: uri, targetSelectionRange: { start: { line: 4, character: 0 } } }), [
    { path: file, line: 5, column: 1 },
  ]);
  assert.deepEqual(toLuaLocations(null), []);
});
