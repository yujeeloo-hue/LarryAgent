import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { __testing, ClangdService } from "./service.js";
import { ClangdDocumentCache } from "./documentCache.js";
import type { CompileDbInspector } from "./compileFlags.js";
import type { LspConnection } from "./lsp.js";
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

const {
  toUri,
  fromUri,
  toLocation,
  parseCompletionList,
  parseTextEdits,
  fileBuildStateOf,
  clangdJobsForWorkspace,
} = __testing;

test("worker selection balances both parsing pools against free memory and CPU", () => {
  const gib = 1024 ** 3;
  assert.equal(clangdJobsForWorkspace(true, 32, 8 * gib, ""), 1);
  assert.equal(clangdJobsForWorkspace(true, 32, 16 * gib, ""), 2);
  assert.equal(clangdJobsForWorkspace(true, 32, 64 * gib, ""), 4);
  assert.equal(clangdJobsForWorkspace(true, 1, 64 * gib, ""), 1);
  assert.equal(clangdJobsForWorkspace(false, 16, 16 * gib, ""), 8);
  assert.equal(clangdJobsForWorkspace(false, 2, 16 * gib, ""), 1);
  assert.equal(clangdJobsForWorkspace(true, 32, 0, ""), 2);
  assert.equal(clangdJobsForWorkspace(true, 32, 64 * gib, "invalid"), 4);
  assert.equal(clangdJobsForWorkspace(true, 32, 8 * gib, "12"), 12);
});

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

test("parseCompletionList forwards clangd's auto-import edits as 1-based ranges", () => {
  const { items } = parseCompletionList([
    {
      label: "UStaticMeshComponent",
      kind: 7,
      insertText: "UStaticMeshComponent",
      additionalTextEdits: [
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
          newText: '#include "Components/StaticMeshComponent.h"\n',
        },
      ],
    },
    { label: "Plain", kind: 7, additionalTextEdits: [] },
  ]);
  assert.deepEqual(items[0]!.additionalTextEdits, [
    {
      line: 3,
      column: 1,
      endLine: 3,
      endColumn: 1,
      newText: '#include "Components/StaticMeshComponent.h"\n',
    },
  ]);
  assert.equal(items[1]!.additionalTextEdits, undefined, "empty edit lists stay off the item");
});

test("parseTextEdits rejects malformed ranges", () => {
  assert.deepEqual(parseTextEdits(null), []);
  assert.deepEqual(parseTextEdits([{ newText: "x" }]), []);
  assert.deepEqual(parseTextEdits([{ range: { start: { line: 0, character: 0 } } }]), []);
  assert.equal(
    parseTextEdits([{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, newText: "a" }])
      .length,
    1,
  );
});

test("uri round-trip keeps Windows drive paths intact", () => {
  const path = "E:/Projects/NF/Source/NF/Main.cpp";
  assert.equal(fromUri(toUri(path)), path);
  assert.equal(toUri("E:\\Projects\\NF\\Main.cpp"), "file:///E:/Projects/NF/Main.cpp");
});

test("uri round-trip keeps POSIX roots and decodes clangd's escapes", () => {
  const header = "/Users/Shared/Epic Games/UE_5.8/Engine/Source/Runtime/Engine/Classes/Components/StaticMeshComponent.h";
  assert.equal(
    fromUri("file:///Users/Shared/Epic%20Games/UE_5.8/Engine/Source/Runtime/Engine/Classes/Components/StaticMeshComponent.h"),
    header,
  );
  assert.equal(toUri(header), "file:///Users/Shared/Epic%20Games/UE_5.8/Engine/Source/Runtime/Engine/Classes/Components/StaticMeshComponent.h");
  assert.equal(fromUri(toUri(header)), header);
  assert.equal(fromUri(toUri("C:/Program Files/Epic Games/X.h")), "C:/Program Files/Epic Games/X.h");
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

function queryHarness(request: () => Promise<unknown> = async () => []) {
  const service = new ClangdService();
  const events: string[] = [];
  const conn = {
    request, notify: (method: string) => events.push(method), dispose: () => events.push("dispose"),
  } as unknown as LspConnection;
  const session: NonNullable<ClangdService["session"]> = {
    root: "C:/Game", clangdPath: "clangd", compileCommandsDir: "C:/Game", engineRoot: null,
    conn, docs: new Map(), editorDocs: new Set(), activeQueries: new Map(),
    idleDocs: new ClangdDocumentCache(uri => service["closeDoc"](session, uri)),
    uhtWatcher: null, warm: false,
    inspector: { inspect: async () => null } as unknown as CompileDbInspector,
    fileBuilds: new Map(), indexStartedAt: null, indexCompletion: null!, indexReady: true, probeUri: "",
  };
  service["session"] = session;
  service["ensure"] = async () => session;
  const position = { path: "C:/Game/Source/Game.cpp", line: 1, column: 5, text: "int Value;" };
  return { service, session, events, position };
}

test("consecutive tool queries reuse one document, including queries supplying text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = queryHarness();
  try {
    assert.equal((await h.service.references("C:/Game", h.position)).ok, true);
    assert.equal((await h.service.references("C:/Game", h.position)).ok, true);
    assert.deepEqual(h.events, ["textDocument/didOpen"]);
    assert.equal(h.session.editorDocs.size, 0);
    t.mock.timers.tick(60_000);
    assert.deepEqual(h.events, ["textDocument/didOpen", "textDocument/didClose"]);
  } finally { h.service.stop(); }
});

test("editor documents stay pinned until explicitly closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = queryHarness();
  try {
    h.service.docChanged("C:/Game", h.position.path, h.position.text);
    await h.service.references("C:/Game", h.position);
    t.mock.timers.tick(120_000);
    assert.deepEqual(h.events, ["textDocument/didOpen"]);
    h.service.docClosed("C:/Game", h.position.path);
    assert.deepEqual(h.events, ["textDocument/didOpen", "textDocument/didClose"]);
  } finally { h.service.stop(); }
});

test("closing an editor during a query releases the document only after that query finishes", async () => {
  let finish!: (value: unknown) => void;
  let started!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  const h = queryHarness(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  try {
    h.service.docChanged("C:/Game", h.position.path, h.position.text);
    const pending = h.service.references("C:/Game", h.position);
    await called;
    h.service.docClosed("C:/Game", h.position.path);
    assert.deepEqual(h.events, ["textDocument/didOpen"]);
    finish([]);
    await pending;
    assert.deepEqual(h.events, ["textDocument/didOpen", "textDocument/didClose"]);
  } finally { h.service.stop(); }
});

test("ending a session cancels document cache callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = queryHarness();
  await h.service.references("C:/Game", h.position);
  h.service.stop();
  t.mock.timers.tick(120_000);
  assert.deepEqual(h.events, ["textDocument/didOpen", "dispose"]);
});

test("generated config upgrades preserve full standard-library indexing and leave user edits intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "jb-clangd-config-"));
  const service = new ClangdService();
  try {
    const path = join(root, ".clangd");
    const legacy = [
      "# Generated by JellyBot (clangd semantic engine). Safe to commit or edit.",
      "CompileFlags:", "  Add: [-D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH]",
      "Diagnostics:", "  UnusedIncludes: None", "Index:", "  StandardLibrary: No", "",
    ].join("\n");
    await writeFile(path, legacy);
    service["writeWorkspaceClangdConfig"](root);
    assert.doesNotMatch(await readFile(path, "utf8"), /StandardLibrary: No/);
    const custom = legacy + "# user-specific index scope\n";
    await writeFile(path, custom);
    service["writeWorkspaceClangdConfig"](root);
    assert.equal(await readFile(path, "utf8"), custom);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
