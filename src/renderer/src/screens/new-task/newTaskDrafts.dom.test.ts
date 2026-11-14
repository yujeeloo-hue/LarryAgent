import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

const extensions = (Module as unknown as { _extensions: Record<string, (...args: any[]) => void> })._extensions;
extensions[".css"] = () => {};
extensions[".png"] = (module: { exports: string }) => { module.exports = "data:image/png;base64,"; };
extensions[".svg"] = (module: { exports: string }, filename: string) => { module.exports = readFileSync(filename, "utf8"); };
const moduleLoader = Module as unknown as { _load: (...args: any[]) => any };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request: string, parent: { filename: string }, ...rest: unknown[]) {
  if (request.endsWith(".svg?raw")) {
    return readFileSync(Module.createRequire(parent.filename).resolve(request.slice(0, -4)), "utf8");
  }
  return originalLoad.call(this, request, parent, ...rest);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
const values = new Map<string, string>();
Object.assign(globalThis, {
  document: dom.document, window: dom.window, Node: dom.Node, Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  getComputedStyle: () => ({
    lineHeight: "20px", fontSize: "13px", paddingTop: "0px", paddingBottom: "0px",
    borderTopWidth: "0px", borderBottomWidth: "0px", getPropertyValue: () => "",
  }),
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

test("pinned New Task drafts survive immediate workspace switches without sharing text", async () => {
  const { NewTaskController } = await import("./NewTaskController.js");
  const { NewTaskView } = await import("./NewTaskView.js");
  const { getSessionDraft, setSessionDraft } = await import("../../state/sessionDrafts.js");
  const { COMPOSER_DRAFT_KEY } = await import("../../state/sessionComposerPrefs.js");
  setSessionDraft(COMPOSER_DRAFT_KEY, "Normal-mode draft");
  function open(workspaceId?: string) {
    const view = new NewTaskView();
    const controller = new NewTaskController(view, {
      onSessionStarted: () => {},
      ...(workspaceId ? { fixedWorkspaceId: workspaceId, draftKey: `devmode:new-task:${workspaceId}` } : {}),
    });
    document.body.append(view.root);
    return { controller, view };
  }
  function type(view: InstanceType<typeof NewTaskView>, prompt: string) {
    view.textarea.value = prompt;
    view.textarea.dispatchEvent(new dom.Event("input", { bubbles: true }));
  }
  const a = open("a");
  assert.equal(a.view.getPrompt(), "");
  type(a.view, "JellyBot task draft");
  a.controller.destroy(); // before the 300ms save timer fires
  const b = open("b");
  assert.equal(b.view.getPrompt(), "");
  type(b.view, "Unreal task draft");
  b.controller.destroy();
  const returned = open("a");
  try {
    assert.equal(returned.view.getPrompt(), "JellyBot task draft");
    assert.equal(getSessionDraft("devmode:new-task:b"), "Unreal task draft");
    assert.equal(getSessionDraft(COMPOSER_DRAFT_KEY), "Normal-mode draft");
  } finally { returned.controller.destroy(); }
  const normal = open();
  try { assert.equal(normal.view.getPrompt(), "Normal-mode draft"); }
  finally { normal.controller.destroy(); }
});
