import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
});
Object.assign(dom.window, {
  matchMedia: () => ({ matches: false }),
  CSS: { escape: (value: string) => value },
});
for (const proto of [dom.window.HTMLElement.prototype, dom.window.Element.prototype]) {
  if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => undefined;
}

const modules = Module as unknown as {
  _load: (...args: any[]) => any;
  _extensions: Record<string, (...args: any[]) => void>;
};
modules._extensions[".css"] = () => {};
modules._extensions[".svg"] = (module: { exports: string }, file: string) => {
  module.exports = readFileSync(file, "utf8");
};
modules._extensions[".png"] = (module: { exports: string }) => {
  module.exports = "data:image/png;base64,";
};
const originalLoad = modules._load;
modules._load = function (request: string, parent: { filename: string }, ...rest: unknown[]) {
  if (request.includes("?worker&inline")) return class WorkerStub {};
  if (request === "monaco-editor/languages/definitions/cpp/cpp.js") return { language: { tokenizer: {} } };
  if (request.endsWith(".svg?raw")) {
    return readFileSync(Module.createRequire(parent.filename).resolve(request.slice(0, -4)), "utf8");
  }
  return originalLoad.call(this, request, parent, ...rest);
};

let Controller: typeof import("./DevModeController.js")["DevModeController"];
test.before(async () => {
  ({ DevModeController: Controller } = await import("./DevModeController.js"));
});

const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise<void>(done => setImmediate(done));
};

const stubDeps = (): ConstructorParameters<typeof Controller>[0] => ({
  getSessionTitle: () => undefined,
  onOpenSession: () => undefined,
  onCreateWorkspace: () => undefined,
  // A session whose workspace cannot be resolved (yet) is exactly the state that used to
  // make annotate claim there is no workspace root.
  getSessionWorkspacePath: () => null,
  getWorkspaceSessions: () => [],
  getWorkspaces: () => [{ id: "ws-1", name: "repo", path: "/repo" }],
});

function tab(path: string) {
  return {
    path,
    label: path.split("/").pop() ?? path,
    languageId: "cpp",
    model: { getValue: () => "", getLineCount: () => 1, dispose() {} },
    dirty: false,
    annotated: false,
    blame: null,
    blameKind: null,
    viewState: null,
  };
}

test("annotate follows the workspace the file tree shows, not the session's workspace", async () => {
  const controller = new Controller(stubDeps());
  // Heavy collaborators are irrelevant here; the editor area and its options stay real.
  Object.assign(controller, {
    sessionId: "session-without-workspace",
    debug: { setWorkspace: async () => undefined, restoreWorkspaceState() {} },
    terminal: { setWorkspace() {} },
    panel: { setWorkspace() {}, ensureWorkspace() {} },
    collaborative: { setWorkspace: async () => undefined },
    outline: { setWorkspace: async () => undefined },
  });
  const internal = controller as unknown as {
    applyWorkspace(path: string | null): Promise<void>;
    editorArea: InstanceType<typeof import("./EditorAreaController.js")["EditorAreaController"]>;
  };
  await internal.applyWorkspace("/repo");
  const area = internal.editorArea as unknown as {
    tabs: Array<{ annotated: boolean }>;
    activePath: string;
    annotateButton: HTMLButtonElement;
    statusNotice: HTMLElement;
    updateEditorToggles(): void;
  };
  area.tabs = [tab("/repo/Source/Foo.cpp")];
  area.activePath = "/repo/Source/Foo.cpp";
  area.updateEditorToggles();

  const calls: Array<[string, string]> = [];
  Object.assign(window, {
    jellybot: {
      annotateFile: async (root: string, path: string) => {
        calls.push([root, path]);
        return { ok: true, kind: "git" as const, lines: [] };
      },
    },
  });
  area.annotateButton.click();
  await tick();

  assert.deepEqual(calls, [["/repo", "/repo/Source/Foo.cpp"]]);
  assert.equal(area.tabs[0]?.annotated, true, "blame was applied to the tab");
  assert.equal(area.statusNotice.textContent, "", "no workspace-root notice");
});
