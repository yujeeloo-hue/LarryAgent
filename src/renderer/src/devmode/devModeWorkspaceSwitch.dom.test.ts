import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, Node: dom.Node, HTMLElement: dom.HTMLElement });
const modules = Module as unknown as { _load: (...args: any[]) => any; _extensions: Record<string, (...args: any[]) => void> };
modules._extensions[".css"] = () => {};
modules._extensions[".svg"] = (module: { exports: string }, file: string) => { module.exports = readFileSync(file, "utf8"); };
modules._extensions[".png"] = (module: { exports: string }) => { module.exports = "data:image/png;base64,"; };
const originalLoad = modules._load;
modules._load = function (request: string, parent: { filename: string }, ...rest: unknown[]) {
  if (request.includes("?worker&inline")) return class WorkerStub {};
  if (request === "monaco-editor/languages/definitions/cpp/cpp.js") return { language: { tokenizer: {} } };
  if (request.endsWith(".svg?raw")) return readFileSync(Module.createRequire(parent.filename).resolve(request.slice(0, -4)), "utf8");
  return originalLoad.call(this, request, parent, ...rest);
};
let Controller: typeof import("./DevModeController.js")["DevModeController"];
test.before(async () => { ({ DevModeController: Controller } = await import("./DevModeController.js")); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Exercise workspace coordination without starting Monaco, DAP or filesystem watchers. */
function harness(debugGates = new Map<string, Promise<void>>(), treeGates = new Map<string, Promise<void>>()) {
  const loaded: string[] = [], restored: string[] = [], panel: string[] = [], terminal: string[] = [];
  const controller = Object.create(Controller.prototype);
  Object.assign(controller, {
    wsApplyGen: 0, requestedWorkspacePath: "/a", workspacePath: "/a", watchedPath: null,
    debug: { setWorkspace: (path: string) => debugGates.get(path) ?? Promise.resolve() },
    terminal: { setWorkspace: (path: string) => terminal.push(path) },
    panel: { setWorkspace: (path: string) => panel.push(path), ensureWorkspace: (path: string) => panel.push(path) },
    editorArea: {
      setUnrealWorkspace: () => Promise.resolve(),
      switchWorkspaceTabs: async (path: string) => { restored.push(path); },
    },
    outline: { setWorkspace: async (path: string) => { loaded.push(path); await treeGates.get(path); } },
  });
  const apply = (path: string) => (controller as { applyWorkspace: (path: string) => Promise<void> }).applyWorkspace(path);
  return { apply, loaded, restored, panel, terminal };
}

test("a superseded workspace switch cannot restore the old tree after debug setup", async () => {
  const slow = deferred();
  const h = harness(new Map([["/b", slow.promise]]));
  const old = h.apply("/b");
  await h.apply("/c");
  slow.resolve(); await old;
  assert.deepEqual(h.loaded, ["/c"]);
  assert.deepEqual(h.restored, ["/c"]);
  assert.deepEqual(h.terminal, ["/c"]);
});

test("a task switch in the same loading workspace preserves its pending tab restoration", async () => {
  const slow = deferred();
  const h = harness(new Map(), new Map([["/b", slow.promise]]));
  const first = h.apply("/b"); await tick();
  await h.apply("/b");
  slow.resolve(); await first;
  assert.deepEqual(h.loaded, ["/b"]);
  assert.deepEqual(h.restored, ["/b"]);
  assert.equal(h.panel.at(-1), "/b");
});

test("a late directory scan cannot reset the new workspace's panel or editor tabs", async () => {
  const slow = deferred();
  const h = harness(new Map(), new Map([["/b", slow.promise]]));
  const old = h.apply("/b"); await tick();
  await h.apply("/c");
  slow.resolve(); await old;
  assert.deepEqual(h.loaded, ["/b", "/c"]);
  assert.deepEqual(h.restored, ["/c"]);
  assert.equal(h.panel.at(-1), "/c");
});

test("switching straight back to the current workspace cancels an unstarted foreign scan", async () => {
  const slow = deferred();
  const h = harness(new Map([["/b", slow.promise]]));
  const old = h.apply("/b");
  await h.apply("/a"); slow.resolve(); await old;
  assert.deepEqual(h.loaded, []);
  assert.deepEqual(h.restored, []);
  assert.equal(h.panel.at(-1), "/a");
});
