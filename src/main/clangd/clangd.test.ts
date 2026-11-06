import assert from "node:assert/strict";
import { test } from "node:test";
import { __testing } from "./service.js";

const { toUri, fromUri, toLocation, parseCompletionList, fileBuildStateOf } = __testing;

test("fileBuildStateOf maps clangd FileStatus text to status-bar states", () => {
  assert.equal(fileBuildStateOf("parsing includes, running Update"), "preamble");
  assert.equal(fileBuildStateOf("parsing includes"), "preamble");
  assert.equal(fileBuildStateOf("parsing main file"), "parsing");
  assert.equal(fileBuildStateOf("idle"), "idle");
  assert.equal(fileBuildStateOf("file is queued"), null);
  assert.equal(fileBuildStateOf("running CodeComplete"), null);
});

test("parseCompletionList strips header-insertion decorators and keeps the signature apart", () => {
  const { items, isIncomplete } = parseCompletionList({
    isIncomplete: true,
    items: [
      {
        label: " GetActorLocation",
        kind: 2,
        detail: "FVector",
        labelDetails: { detail: "() const" },
        insertTextFormat: 2,
        textEdit: { newText: "GetActorLocation()", range: {} },
        filterText: "GetActorLocation",
      },
      { label: "•FMath", kind: 7, insertText: "FMath", insertTextFormat: 1 },
    ],
  });
  assert.equal(isIncomplete, true);
  assert.deepEqual(items[0], {
    label: "GetActorLocation",
    kind: 2,
    detail: "FVector",
    signature: "() const",
    insertText: "GetActorLocation()",
    isSnippet: true,
    filterText: "GetActorLocation",
  });
  assert.equal(items[1]!.label, "FMath");
  assert.equal(items[1]!.isSnippet, undefined);
});

test("uri round-trip keeps Windows drive paths intact", () => {
  const path = "E:/Projects/NF/Source/NF/Main.cpp";
  assert.equal(fromUri(toUri(path)), path);
  assert.equal(toUri("E:\\Projects\\NF\\Main.cpp"), "file:///E:/Projects/NF/Main.cpp");
});

test("toLocation maps LSP 0-based positions to 1-based and reads LocationLink targets", () => {
  const loc = toLocation({
    uri: "file:///E:/P/A.cpp",
    range: { start: { line: 4, character: 6 }, end: { line: 4, character: 12 } },
  });
  assert.deepEqual(loc, {
    path: "E:/P/A.cpp",
    line: 5,
    column: 7,
    endLine: 5,
    endColumn: 13,
  });

  const link = toLocation({
    targetUri: "file:///E:/P/B.h",
    targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  });
  assert.equal(link?.path, "E:/P/B.h");
  assert.equal(link?.line, 1);
});

test("toLocation rejects malformed payloads", () => {
  assert.equal(toLocation(null), null);
  assert.equal(toLocation({ uri: "file:///x", range: null }), null);
  assert.equal(
    toLocation({ uri: "file:///x", range: { start: { line: "a", character: 0 } } }),
    null,
  );
});
