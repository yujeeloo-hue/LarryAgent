import assert from "node:assert/strict";
import { test } from "node:test";
import { __testing } from "./service.js";
import { LspFrameReader } from "./lsp.js";

function frame(body: string): Buffer {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8");
}

test("LspFrameReader frames by UTF-8 bytes so non-ASCII bodies survive", () => {
  const reader = new LspFrameReader();
  const first = JSON.stringify({ id: 1, result: { documentation: "攻击目标 • ’" } });
  const second = JSON.stringify({ id: 2, result: null });
  const joined = Buffer.concat([frame(first), frame(second)]);
  assert.deepEqual(reader.push(joined), [first, second]);
});

test("LspFrameReader reassembles a body split inside a multi-byte character", () => {
  const reader = new LspFrameReader();
  const body = JSON.stringify({ id: 3, result: "中文注释" });
  const bytes = frame(body);
  const cut = bytes.indexOf(Buffer.from("文")) + 1;
  assert.deepEqual(reader.push(bytes.subarray(0, cut)), []);
  assert.deepEqual(reader.push(bytes.subarray(cut)), [body]);
});

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
