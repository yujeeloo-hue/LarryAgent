import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLspTextEdits,
  lspRangeText,
  parsePrepareRenameResult,
  parseWorkspaceEdit,
} from "./lspEdits.js";

const toPath = (uri: string): string | null => (uri.startsWith("file:///") ? uri.slice("file:///".length) : null);

test("applyLspTextEdits rewrites every occurrence regardless of edit order", () => {
  const text = "int Value = 1;\nValue += Value;\n";
  const edits = [
    { line: 2, column: 10, endLine: 2, endColumn: 15, newText: "Count" },
    { line: 1, column: 5, endLine: 1, endColumn: 10, newText: "Count" },
    { line: 2, column: 1, endLine: 2, endColumn: 6, newText: "Count" },
  ];
  assert.equal(applyLspTextEdits(text, edits), "int Count = 1;\nCount += Count;\n");
});

test("applyLspTextEdits keeps CRLF line endings intact", () => {
  const text = "a\r\nFoo();\r\nFoo();";
  const edits = [
    { line: 2, column: 1, endLine: 2, endColumn: 4, newText: "Bar" },
    { line: 3, column: 1, endLine: 3, endColumn: 4, newText: "Bar" },
  ];
  assert.equal(applyLspTextEdits(text, edits), "a\r\nBar();\r\nBar();");
});

test("applyLspTextEdits handles zero-width inserts and rejects overlaps", () => {
  assert.equal(
    applyLspTextEdits("abc", [{ line: 1, column: 2, endLine: 1, endColumn: 2, newText: "X" }]),
    "aXbc",
  );
  assert.throws(() => applyLspTextEdits("abcdef", [
    { line: 1, column: 1, endLine: 1, endColumn: 4, newText: "x" },
    { line: 1, column: 2, endLine: 1, endColumn: 5, newText: "y" },
  ]), /Overlapping/);
});

test("applyLspTextEdits refuses ranges outside the file", () => {
  assert.throws(() => applyLspTextEdits("abc", [
    { line: 3, column: 1, endLine: 3, endColumn: 2, newText: "x" },
  ]), /outside the file/);
  assert.throws(() => applyLspTextEdits("abc", [
    { line: 1, column: 1, endLine: 1, endColumn: 9, newText: "x" },
  ]), /outside the file/);
});

test("lspRangeText returns the text a range covers", () => {
  assert.equal(lspRangeText("int Value;", { line: 1, column: 5, endLine: 1, endColumn: 10 }), "Value");
});

test("parseWorkspaceEdit reads the changes map and drops duplicate edits", () => {
  const edit = {
    range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
    newText: "Count",
  };
  const result = parseWorkspaceEdit(
    { changes: { "file:///C:/P/A.cpp": [edit, edit], "file:///C:/P/B.h": [edit] } },
    toPath,
  );
  assert.deepEqual(result, {
    ok: true,
    files: [
      { path: "C:/P/A.cpp", edits: [{ line: 1, column: 5, endLine: 1, endColumn: 10, newText: "Count" }] },
      { path: "C:/P/B.h", edits: [{ line: 1, column: 5, endLine: 1, endColumn: 10, newText: "Count" }] },
    ],
  });
});

test("parseWorkspaceEdit reads documentChanges and rejects file operations", () => {
  const edit = {
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
    newText: "New",
  };
  const ok = parseWorkspaceEdit(
    { documentChanges: [{ textDocument: { uri: "file:///P/A.lua", version: 1 }, edits: [edit] }] },
    toPath,
  );
  assert.deepEqual(ok, {
    ok: true,
    files: [{ path: "P/A.lua", edits: [{ line: 2, column: 1, endLine: 2, endColumn: 4, newText: "New" }] }],
  });
  const created = parseWorkspaceEdit({ documentChanges: [{ kind: "create", uri: "file:///P/New.h" }] }, toPath);
  assert.equal(created.ok, false);
});

test("parseWorkspaceEdit refuses the whole result when one edit is malformed or unmappable", () => {
  const good = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" };
  assert.equal(
    parseWorkspaceEdit({ changes: { "file:///P/A.cpp": [good, { newText: "y" }] } }, toPath).ok,
    false,
  );
  assert.equal(
    parseWorkspaceEdit({ changes: { "untitled:Untitled-1": [good] } }, toPath).ok,
    false,
  );
});

test("parseWorkspaceEdit treats a null result as no edits", () => {
  assert.deepEqual(parseWorkspaceEdit(null, toPath), { ok: true, files: [] });
});

test("parsePrepareRenameResult accepts every LSP prepareRename shape", () => {
  const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } };
  const expected = { line: 3, column: 5, endLine: 3, endColumn: 10 };
  assert.deepEqual(parsePrepareRenameResult(range), { range: expected });
  assert.deepEqual(parsePrepareRenameResult({ range, placeholder: "Value" }), { range: expected });
  assert.deepEqual(parsePrepareRenameResult({ defaultBehavior: true }), { range: null });
  assert.equal(parsePrepareRenameResult(null), null);
});
