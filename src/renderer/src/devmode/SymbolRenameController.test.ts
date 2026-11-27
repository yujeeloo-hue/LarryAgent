import assert from "node:assert/strict";
import { test } from "node:test";
import type { LspFileEdit } from "../../../shared/lspEdits.js";
import {
  SymbolRenameController,
  type OpenDocument,
  type SymbolRenameBackend,
  type SymbolRenameDeps,
  type SymbolRenameTarget,
} from "./SymbolRenameController.js";

const ROOT = "C:/Game";
const SOURCE = "C:/Game/Source/Game.cpp";
const HEADER = "C:/Game/Source/Game.h";
const ENGINE = "C:/Engine/Source/Core.h";
const GENERATED = "C:/Game/Intermediate/Game.generated.h";

const HEADER_TEXT = "class Widget {\r\n  int Value;\r\n};\r\n";
const SOURCE_TEXT = "void Use(Widget& w) {\n  w.Value = 1;\n}\n";

function harness(options: {
  files?: LspFileEdit[];
  open?: Record<string, OpenDocument>;
  disk?: Record<string, { text: string; hadBom: boolean }>;
  prepareRange?: { line: number; column: number; endLine: number; endColumn: number } | null;
  renameError?: string;
  name?: string | null;
  confirm?: boolean;
  workspace?: string | null;
  onConfirm?: () => void;
} = {}) {
  const open = new Map(Object.entries(options.open ?? {}));
  const disk = new Map(Object.entries(options.disk ?? {}));
  const notices: string[] = [];
  const writes: Array<{ path: string; text: string; hadBom: boolean }> = [];
  const applied: Array<{ path: string; edits: number }> = [];
  const saves: string[] = [];
  const confirms: Array<{ message: string; detail: string }> = [];
  let renameCalls = 0;
  let promptCalls = 0;
  const backend: SymbolRenameBackend = {
    prepare: async () => ({
      ok: true,
      range: options.prepareRange === undefined ? { line: 2, column: 5, endLine: 2, endColumn: 10 } : options.prepareRange,
    }),
    rename: async () => {
      renameCalls++;
      if (options.renameError) return { ok: false, message: options.renameError };
      return { ok: true, files: options.files ?? [] };
    },
  };
  const deps: SymbolRenameDeps = {
    workspaceRoot: () => (options.workspace === undefined ? ROOT : options.workspace),
    backendFor: (languageId) => (languageId === "cpp" ? backend : null),
    openDocument: (path) => open.get(path) ?? null,
    openVersions: () => new Map([...open].map(([path, doc]) => [path, doc.version] as const)),
    applyOpenEdits: (path, edits) => {
      applied.push({ path, edits: edits.length });
      const doc = open.get(path);
      if (doc) open.set(path, { ...doc, version: doc.version + 1, dirty: true });
      return true;
    },
    saveOpenDocument: async (path) => {
      saves.push(path);
      const doc = open.get(path);
      if (doc) open.set(path, { ...doc, dirty: false });
      return { ok: true };
    },
    readFile: async (path) => {
      const entry = disk.get(path);
      return entry ? { ok: true, ...entry } : { ok: false, message: "Missing file." };
    },
    writeFile: async (path, text, hadBom) => {
      writes.push({ path, text, hadBom });
      return { ok: true };
    },
    promptName: async () => {
      promptCalls++;
      return options.name === undefined ? "Count" : options.name;
    },
    confirm: async (message, detail) => {
      confirms.push({ message, detail });
      options.onConfirm?.();
      return options.confirm ?? true;
    },
    notice: (message) => {
      notices.push(message);
    },
  };
  const controller = new SymbolRenameController(deps);
  const target: SymbolRenameTarget = {
    languageId: "cpp",
    path: SOURCE,
    line: 2,
    column: 5,
    text: SOURCE_TEXT,
    word: "Value",
  };
  return {
    controller,
    target,
    notices,
    writes,
    applied,
    saves,
    confirms,
    open,
    get renameCalls() { return renameCalls; },
    get promptCalls() { return promptCalls; },
  };
}

const VALUE_IN_SOURCE = (line: number, column: number) => ({ line, column, endLine: line, endColumn: column + 5, newText: "Count" });

test("a clean open file is renamed and saved", async () => {
  const h = harness({
    open: { [SOURCE]: { version: 3, text: SOURCE_TEXT, dirty: false, readOnly: false, hadBom: false } },
    files: [{ path: SOURCE, edits: [VALUE_IN_SOURCE(2, 5)] }],
  });
  await h.controller.rename(h.target);
  assert.deepEqual(h.applied, [{ path: SOURCE, edits: 1 }]);
  assert.deepEqual(h.saves, [SOURCE]);
  assert.equal(h.confirms.length, 1);
  assert.deepEqual(h.writes, []);
  assert.match(h.notices.at(-1)!, /Renamed Value to Count: 1 occurrence\(s\) in 1 file\(s\)\./);
});

test("a dirty open file is edited but left unsaved without confirmation", async () => {
  const h = harness({
    open: { [SOURCE]: { version: 3, text: SOURCE_TEXT, dirty: true, readOnly: false, hadBom: false } },
    files: [{ path: SOURCE, edits: [VALUE_IN_SOURCE(2, 5)] }],
  });
  await h.controller.rename(h.target);
  assert.deepEqual(h.applied, [{ path: SOURCE, edits: 1 }]);
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.confirms, []);
  assert.deepEqual(h.writes, []);
  assert.match(h.notices.at(-1)!, /1 open file\(s\) with unsaved changes were edited but not saved/);
});

test("clean open files are saved while dirty ones stay unsaved in the same rename", async () => {
  const h = harness({
    open: {
      [SOURCE]: { version: 1, text: SOURCE_TEXT, dirty: true, readOnly: false, hadBom: false },
      [HEADER]: { version: 1, text: HEADER_TEXT, dirty: false, readOnly: false, hadBom: false },
    },
    files: [
      { path: SOURCE, edits: [VALUE_IN_SOURCE(2, 5)] },
      { path: HEADER, edits: [{ line: 2, column: 7, endLine: 2, endColumn: 12, newText: "Count" }] },
    ],
  });
  await h.controller.rename(h.target);
  assert.equal(h.confirms.length, 1);
  assert.deepEqual(h.applied.map((entry) => entry.path), [SOURCE, HEADER]);
  assert.deepEqual(h.saves, [HEADER]);
  assert.deepEqual(h.writes, []);
  assert.match(h.notices.at(-1)!, /1 open file\(s\) with unsaved changes were edited but not saved/);
});

test("a multi-file rename confirms first and writes closed files with their BOM state", async () => {
  const h = harness({
    open: { [SOURCE]: { version: 1, text: SOURCE_TEXT, dirty: true, readOnly: false, hadBom: false } },
    disk: { [HEADER]: { text: HEADER_TEXT, hadBom: true } },
    files: [
      { path: SOURCE, edits: [VALUE_IN_SOURCE(2, 5)] },
      { path: HEADER, edits: [{ line: 2, column: 7, endLine: 2, endColumn: 12, newText: "Count" }] },
    ],
  });
  await h.controller.rename(h.target);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.applied.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]!.path, HEADER);
  assert.equal(h.writes[0]!.hadBom, true);
  assert.equal(h.writes[0]!.text, "class Widget {\r\n  int Count;\r\n};\r\n");
  assert.match(h.notices.at(-1)!, /2 occurrence\(s\) in 2 file\(s\)/);
});

test("a cancelled name prompt never asks the language server to rename", async () => {
  const h = harness({ name: null, files: [{ path: SOURCE, edits: [VALUE_IN_SOURCE(2, 5)] }] });
  await h.controller.rename(h.target);
  assert.equal(h.promptCalls, 1);
  assert.equal(h.renameCalls, 0);
  assert.deepEqual(h.notices, []);
});

test("edits that leave the workspace stop the rename before anything is written", async () => {
  const h = harness({
    disk: { [HEADER]: { text: HEADER_TEXT, hadBom: false }, [ENGINE]: { text: "int Value;", hadBom: false } },
    files: [
      { path: HEADER, edits: [{ line: 2, column: 7, endLine: 2, endColumn: 12, newText: "Count" }] },
      { path: ENGINE, edits: [{ line: 1, column: 5, endLine: 1, endColumn: 10, newText: "Count" }] },
    ],
  });
  await h.controller.rename(h.target);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.applied, []);
  assert.match(h.notices.at(-1)!, /outside the workspace/);
});

test("path spellings of one file are merged into a single write", async () => {
  const edit = { line: 2, column: 7, endLine: 2, endColumn: 12, newText: "Count" };
  const h = harness({
    disk: { [HEADER]: { text: HEADER_TEXT, hadBom: false } },
    files: [
      { path: HEADER, edits: [edit] },
      { path: HEADER.replace("C:/", "c:/"), edits: [edit] },
    ],
  });
  await h.controller.rename(h.target);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]!.text, "class Widget {\r\n  int Count;\r\n};\r\n");
  assert.match(h.notices.at(-1)!, /1 occurrence\(s\) in 1 file\(s\)/);
});

test("generated Unreal files are left alone and reported", async () => {
  const h = harness({
    disk: { [HEADER]: { text: HEADER_TEXT, hadBom: false } },
    files: [
      { path: HEADER, edits: [{ line: 2, column: 7, endLine: 2, endColumn: 12, newText: "Count" }] },
      { path: GENERATED, edits: [{ line: 1, column: 1, endLine: 1, endColumn: 4, newText: "Count" }] },
    ],
  });
  await h.controller.rename(h.target);
  assert.equal(h.writes.length, 1);
  assert.match(h.notices.at(-1)!, /Left 1 generated file\(s\) alone/);
});

test("a result whose ranges no longer hold the old name is refused", async () => {
  const h = harness({
    disk: { [HEADER]: { text: HEADER_TEXT, hadBom: false } },
    files: [{ path: HEADER, edits: [{ line: 2, column: 3, endLine: 2, endColumn: 8, newText: "Count" }] }],
  });
  await h.controller.rename(h.target);
  assert.deepEqual(h.writes, []);
  assert.match(h.notices.at(-1)!, /no longer matches Game\.h|no longer matches Source/);
});

test("a file edited while the confirmation was open blocks the rename", async () => {
  const h = harness({
    open: { [SOURCE]: { version: 1, text: SOURCE_TEXT, dirty: true, readOnly: false, hadBom: false } },
    disk: { [HEADER]: { text: HEADER_TEXT, hadBom: false } },
    files: [
      { path: SOURCE, edits: [VALUE_IN_SOURCE(2, 5)] },
      { path: HEADER, edits: [{ line: 2, column: 7, endLine: 2, endColumn: 12, newText: "Count" }] },
    ],
    onConfirm: () => h.open.set(SOURCE, { version: 2, text: SOURCE_TEXT + "// typed\n", dirty: true, readOnly: false, hadBom: false }),
  });
  await h.controller.rename(h.target);
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.writes, []);
  assert.match(h.notices.at(-1)!, /changed before the rename could be applied/);
});

test("read-only open documents are never edited", async () => {
  const h = harness({
    open: { [SOURCE]: { version: 1, text: SOURCE_TEXT, dirty: false, readOnly: true, hadBom: false } },
    files: [{ path: SOURCE, edits: [VALUE_IN_SOURCE(2, 5)] }],
  });
  await h.controller.rename(h.target);
  assert.deepEqual(h.applied, []);
  assert.match(h.notices.at(-1)!, /read-only/);
});

test("a language without a backend is reported without prompting", async () => {
  const h = harness();
  await h.controller.rename({ ...h.target, languageId: "python" });
  assert.equal(h.promptCalls, 0);
  assert.match(h.notices.at(-1)!, /C\+\+ and Lua/);
});

test("server errors surface as notices without touching files", async () => {
  const h = harness({ renameError: "new name is not a valid identifier", files: [] });
  await h.controller.rename(h.target);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.applied, []);
  assert.equal(h.notices.at(-1), "new name is not a valid identifier");
});
