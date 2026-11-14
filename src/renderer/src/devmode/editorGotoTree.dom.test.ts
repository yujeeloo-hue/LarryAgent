/**
 * F12 / Ctrl+click landings ask the file tree to select the opened file.
 * Ordinary opens (tree click, Quick Open) do not — those only sync a row
 * that is already on screen.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});
Object.assign(dom.window, {
  matchMedia: () => ({ matches: true }),
  CSS: { escape: (value: string) => value },
});
for (const proto of [dom.window.HTMLElement.prototype, dom.window.Element.prototype]) {
  if (typeof proto.scrollIntoView !== "function") {
    proto.scrollIntoView = () => undefined;
  }
}

const origLoad = (
  Module as unknown as { _load: (...args: unknown[]) => unknown }
)._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load =
  function patchedLoad(this: unknown, request: string, ...rest: unknown[]): unknown {
    if (request.includes("?worker&inline")) return class WorkerStub {};
    if (request === "monaco-editor/languages/definitions/cpp/cpp.js") {
      return { language: { tokenizer: {} } };
    }
    if (request.endsWith(".css")) return {};
    return origLoad.call(this, request, ...rest);
  };

type EditorAreaControllerT = typeof import("./EditorAreaController.js")["EditorAreaController"];
let EditorAreaController: EditorAreaControllerT;

test.before(async () => {
  ({ EditorAreaController } = await import("./EditorAreaController.js"));
  // Opening a tab awaits Monaco. These tests only care about the tree
  // callback, which fires before the editor bootstrap.
  (
    EditorAreaController.prototype as unknown as {
      ensureMonaco: () => Promise<void>;
    }
  ).ensureMonaco = () => Promise.resolve();
});

const FILE_OK = {
  ok: true as const,
  content: "class Foo {}",
  encoding: "utf8" as const,
  sizeBytes: 12,
  mtimeMs: 1,
};

function areaWith(revealed: string[]) {
  const area = new EditorAreaController({
    onRevealInTree: (path) => revealed.push(path),
  });
  return area;
}

test("F12 landing selects the opened file in the tree", async () => {
  const revealed: string[] = [];
  const area = areaWith(revealed);
  Object.assign(window, {
    jellybot: {
      readFileForEditor: async () => FILE_OK,
    },
  });

  await area.revealFileLine("E:\\work\\NF\\Source\\Foo.cpp", 40, 1, {
    revealInTree: true,
  });
  assert.deepEqual(revealed, ["E:/work/NF/Source/Foo.cpp"]);

  // Already the active tab — activateTab no-ops, the tree still follows.
  revealed.length = 0;
  await area.revealFileLine("E:/work/NF/Source/Foo.cpp", 80, 1, {
    revealInTree: true,
  });
  assert.deepEqual(revealed, ["E:/work/NF/Source/Foo.cpp"]);
});

test("Quick Open and a failed read do not move the tree", async () => {
  const revealed: string[] = [];
  const area = areaWith(revealed);
  Object.assign(window, {
    jellybot: {
      readFileForEditor: async () => FILE_OK,
    },
  });

  await area.openFile("E:\\work\\NF\\Source\\Bar.cpp");
  await area.revealFileLine("E:\\work\\NF\\Source\\Baz.cpp", 3);
  assert.deepEqual(revealed, []);

  Object.assign(window, {
    jellybot: {
      readFileForEditor: async () => ({ ok: false as const, message: "missing" }),
    },
  });
  await area.revealFileLine("E:\\missing.cpp", 1, 1, { revealInTree: true });
  assert.deepEqual(revealed, []);
});
