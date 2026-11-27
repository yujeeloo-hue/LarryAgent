import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
});
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});
dom.window.matchMedia = () => ({ matches: true });

for (const proto of [
  dom.window.HTMLElement.prototype,
  dom.window.Element.prototype,
]) {
  if (typeof proto.scrollIntoView !== "function") {
    proto.scrollIntoView = () => undefined;
  }
}

const origLoad = (
  Module as unknown as { _load: (...args: never[]) => unknown }
)._load;
(Module as unknown as { _load: (...args: never[]) => unknown })._load =
  function patchedLoad(
    this: unknown,
    request: string,
    ...rest: never[]
  ): unknown {
    if (request.includes("?worker&inline")) return class WorkerStub {};
    if (request === "monaco-editor/languages/definitions/cpp/cpp.js") {
      return { language: { tokenizer: {} } };
    }
    if (request.endsWith(".css")) return {};
    return origLoad.call(this, request, ...rest);
  };

type EditorAreaControllerT =
  typeof import("./EditorAreaController.js")["EditorAreaController"];
let EditorAreaController: EditorAreaControllerT;

test.before(async () => {
  ({ EditorAreaController } = await import("./EditorAreaController.js"));
  (
    EditorAreaController.prototype as unknown as {
      ensureMonaco: () => Promise<void>;
    }
  ).ensureMonaco = () => Promise.resolve();
});

const ROOT = "E:/work";
const fileOk = (content = "class Foo {}") => ({
  ok: true as const,
  content,
  encoding: "utf8" as const,
  sizeBytes: content.length,
  mtimeMs: 1,
});

function seedTabs(files: string[], active: string | null): void {
  storage.set(
    `jellybot.devmode.tabs.${ROOT}`,
    JSON.stringify({ files, active }),
  );
}

function installBridge(): void {
  Object.assign(window, {
    jellybot: { readFileForEditor: async () => fileOk() },
  });
}

test("restoring a workspace reveals the active tab in the file tree", async () => {
  installBridge();
  storage.clear();
  seedTabs(
    ["E:/work/Alpha.ts", "E:/work/Beta.ts", "E:/work/Gamma.ts"],
    "E:/work/Beta.ts",
  );
  const revealed: string[] = [];
  const area = new EditorAreaController({
    onRevealInTree: (path) => revealed.push(path),
  });
  try {
    assert.equal(await area.switchWorkspaceTabs(ROOT), true);
    assert.equal(area.getOpenFiles().activeFile, "E:/work/Beta.ts");
    assert.deepEqual(revealed, ["E:/work/Beta.ts"]);
  } finally {
    area.destroy();
  }
});

test("a restore without a saved active tab reveals the tab it falls back to", async () => {
  installBridge();
  storage.clear();
  seedTabs(["E:/work/Alpha.ts", "E:/work/Beta.ts"], null);
  const revealed: string[] = [];
  const area = new EditorAreaController({
    onRevealInTree: (path) => revealed.push(path),
  });
  try {
    await area.switchWorkspaceTabs(ROOT);
    assert.equal(area.getOpenFiles().activeFile, "E:/work/Beta.ts");
    assert.deepEqual(revealed, ["E:/work/Beta.ts"]);
  } finally {
    area.destroy();
  }
});

test("an agent-opened file keeps its plain activation (no forced tree jump)", async () => {
  installBridge();
  storage.clear();
  const sources: Array<string | undefined> = [];
  const revealed: string[] = [];
  const area = new EditorAreaController({
    onActiveTabChanged: (_path, source) => sources.push(source),
    onRevealInTree: (path) => revealed.push(path),
  });
  try {
    await area.openFile("E:/work/Alpha.ts");
    assert.deepEqual(sources, ["open"]);
    assert.deepEqual(revealed, []);
  } finally {
    area.destroy();
  }
});
