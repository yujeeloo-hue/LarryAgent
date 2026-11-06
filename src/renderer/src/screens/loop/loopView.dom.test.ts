/**
 * Loop editor open/close — regression repro:
 * `buildEditor()` used to return `this.reasoningSeg` (the class field,
 * still undefined during construction) instead of its local EffortSegView
 * instance, so `openEditor()` crashed on `setLevel()` and both "New Loop"
 * and per-card "Edit" clicks died silently.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
if (!dom.HTMLElement.prototype.focus) {
  dom.HTMLElement.prototype.focus = function focus(): void {};
}
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  SVGElement: dom.SVGElement,
  Element: dom.Element,
  Node: dom.Node,
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number,
});
const doc = dom.document;
// linkedom's <select> exposes `value` as getter-only — add a setter that
// marks the matching <option> selected (what the editor's fillSelect needs).
const selectProto = Object.getPrototypeOf(doc.createElement("select")) as {
  value: string;
};
const valueDesc = Object.getOwnPropertyDescriptor(selectProto, "value");
if (valueDesc && valueDesc.set === undefined) {
  Object.defineProperty(selectProto, "value", {
    get: valueDesc.get,
    set(this: HTMLSelectElement, v: string) {
      for (const option of Array.from(this.querySelectorAll("option"))) {
        if (option.value === v) {
          option.selected = true;
          return;
        }
      }
    },
    configurable: true,
  });
}
// linkedom's select.options (NodeList) lacks namedItem — the editor uses it
// to select the cadence-kind option by id.
const optionsDesc = Object.getOwnPropertyDescriptor(selectProto, "options");
if (optionsDesc?.get) {
  Object.defineProperty(selectProto, "options", {
    get(this: HTMLSelectElement) {
      const list = optionsDesc.get.call(this) as Array<HTMLOptionElement> & {
        namedItem?: (name: string) => HTMLOptionElement | null;
      };
      if (list.namedItem === undefined) {
        const byId = new Map(
          Array.from(list)
            .filter((option) => option.id)
            .map((option) => [option.id, option]),
        );
        list.namedItem = (name: string) => byId.get(name) ?? null;
      }
      return list;
    },
    configurable: true,
  });
}

type ViewT = typeof import("./LoopView.js")["LoopView"];
let LoopView: ViewT;

test.before(async () => {
  ({ LoopView } = await import("./LoopView.js"));
});

const build = () => {
  const view = new LoopView();
  doc.body.append(view.root);
  return view;
};

const sampleLoop = {
  id: "loop-1",
  name: "Morning digest",
  prompt: "Summarize the inbox",
  workspaceId: "ws-1",
  runMode: "agent",
  providerId: "prov-1",
  reasoningEffort: "low",
  fullPermissions: false,
  cadenceJson: JSON.stringify({ kind: "day", time: "09:00" }),
  cadenceSummary: "Daily at 09:00",
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  runCount: 0,
  createdAt: 0,
  updatedAt: 0,
} as unknown as import("./loopTypes.js").LoopRecordView;

const editorOptions = {
  workspaces: [{ id: "ws-1", name: "JellyBot" }],
  providers: [{ id: "prov-1", name: "Anthropic", modelId: "claude-x" }],
};

test("New Loop click opens the editor instead of dying silently", () => {
  const view = build();
  assert.equal(view.editorOpen(), false);
  view.onNewLoop(() => view.openEditor(null, {
    workspaceId: "ws-1",
    providerId: "prov-1",
  }, editorOptions));
  const btn = view.root.querySelector<HTMLButtonElement>(
    ".loop-toolbar .setting-btn-primary",
  );
  assert.ok(btn, "toolbar New Loop button exists");
  btn.click();
  assert.equal(view.editorOpen(), true, "editor visible after click");
  const title = view.root.querySelector(".loop-editor .setting-card-title");
  assert.equal(title?.textContent, "New Loop");
});

test("Edit click opens the editor prefilled with the loop", () => {
  const view = build();
  view.renderLoops({
    loops: [sampleLoop],
    workspaceNames: new Map([["ws-1", "JellyBot"]]),
    providerLabels: new Map([["prov-1", "Anthropic · claude-x"]]),
    expandedIds: new Set(),
    runsByLoopId: new Map(),
    runsLoading: new Set(),
  });
  view.onEditLoop((loopId) => {
    assert.equal(loopId, "loop-1");
    view.openEditor(sampleLoop, {
      workspaceId: "ws-1",
      providerId: "prov-1",
    }, editorOptions);
  });
  const editBtn = view.root.querySelector<HTMLButtonElement>(
    ".loop-card-edit",
  );
  assert.ok(editBtn, "card edit button exists");
  editBtn.click();
  assert.equal(view.editorOpen(), true, "editor visible after edit click");
  const title = view.root.querySelector(".loop-editor .setting-card-title");
  assert.equal(title?.textContent, "Edit Loop");
  const nameInput = view.root.querySelector<HTMLInputElement>(
    ".loop-editor input.setting-input",
  );
  assert.equal(nameInput?.value, "Morning digest", "name prefilled");
});

test("collectInput works — effort seg field is the real instance", () => {
  const view = build();
  view.openEditor(sampleLoop, {
    workspaceId: "ws-1",
    providerId: "prov-1",
  }, editorOptions);
  const result = view.collectInput();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.name, "Morning digest");
    assert.equal(result.payload.reasoningEffort, "low");
  }
});


test("daemon action switches its semantic color with Start and Stop", () => {
  const view = build();
  const display = {
    tone: "stopped" as const,
    label: "Stopped",
    detail: "The scheduler is stopped",
    action: "ensure" as const,
    actionLabel: "Start",
  };
  view.renderDaemon(display, false);
  const button = view.root.querySelector<HTMLButtonElement>(
    ".loop-daemon-actions .setting-btn",
  );
  assert.ok(button);
  assert.equal(button.classList.contains("action-primary"), true);
  assert.equal(button.classList.contains("action-danger"), false);

  view.renderDaemon({
    ...display,
    tone: "running",
    label: "Running",
    action: "stop",
    actionLabel: "Stop",
  }, false);
  assert.equal(button.classList.contains("action-primary"), false);
  assert.equal(button.classList.contains("action-danger"), true);

  view.renderDaemon(display, true);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.classList.contains("action-primary"), true);
  assert.equal(button.classList.contains("action-danger"), false);

  view.renderDaemon(display, false);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), "false");

  view.renderDaemon(null, false);
  assert.equal(button.hidden, true);
  assert.equal(button.classList.contains("action-primary"), false);
  assert.equal(button.classList.contains("action-danger"), false);
});
