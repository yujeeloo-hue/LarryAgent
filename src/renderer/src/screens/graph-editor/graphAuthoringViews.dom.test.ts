import assert from "node:assert/strict";
import Module from "node:module";
import { before, it } from "node:test";
import { parseHTML } from "linkedom";
import type { GraphValidation } from "../../../../agent/fsm/authoring/diagnostics.js";
(Module as unknown as {
  _extensions: Record<string, () => void>;
})._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  if (request.endsWith(".svg")) return request;
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  localStorage: {
    getItem: () => null,
    setItem: () => {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {}
});
let GraphEditorView: typeof import("./GraphEditorView.js").GraphEditorView;
let GraphsView: typeof import("../graphs/GraphsView.js").GraphsView;
before(async () => {
  ({
    GraphEditorView
  } = await import("./GraphEditorView.js"));
  ({
    GraphsView
  } = await import("../graphs/GraphsView.js"));
});
function validation(valid: boolean): GraphValidation {
  return {
    valid,
    fingerprint: "current",
    errors: valid ? 0 : 1,
    warnings: 0,
    scope: "Static validation",
    issues: valid ? [] : [{
      code: "ACTION_PREREQUISITE_MISSING",
      severity: "error",
      stage: "actions",
      path: "nodes[1].actions[2]",
      nodeId: "agent",
      actionId: "call",
      message: "Missing model window",
      suggestion: "Insert BuildModelWindow before CallModel."
    }]
  };
}
it("keeps invalid and draft graph switches disabled after busy-state refreshes", () => {
  const view = new GraphsView();
  view.setGraphs([{
    id: "invalid",
    name: "Needs repair",
    enabled: false,
    origin: "llm",
    updatedAt: 1,
    validation: validation(false)
  }, {
    id: "draft",
    name: "Draft",
    enabled: false,
    origin: "llm",
    updatedAt: 1,
    validation: validation(true),
    draftContextId: "editing"
  }, {
    id: "ready",
    name: "Ready",
    enabled: false,
    origin: "llm",
    updatedAt: 1,
    validation: validation(true)
  }]);
  view.setBusy(true);
  view.setBusy(false);
  const switches = [...view.root.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
  assert.deepEqual(switches.map(input => input.disabled), [true, true, false]);
  assert.match(view.root.textContent!, /Needs fixes/);
  assert.ok(view.root.querySelector<HTMLButtonElement>(".graphs-row-main")?.disabled === false, "invalid graph remains openable for editing");
});
it("keeps Validate in the toolbar and gates draft commit without a status bar", () => {
  const view = new GraphEditorView();
  view.setDraftMode(true);
  view.setCommitEnabled(false);
  const buttons = [...view.root.querySelectorAll<HTMLButtonElement>("button")];
  const commit = buttons.find(button => button.textContent === "Commit draft")!;
  assert.equal(commit.hidden, false);
  assert.equal(commit.disabled, true);
  assert.equal(view.root.querySelector(".graph-editor-validation"), null);
  const validate = buttons.find(button => button.textContent === "Validate")!;
  assert.ok(validate.closest(".graph-editor-toolbar-end"));
  assert.equal(view.root.querySelector(".graph-editor-status"), null);
  let requested = 0;
  view.setCallbacks({ onValidate: () => requested++ });
  validate.click();
  assert.equal(requested, 1);
  view.setValidating(true);
  assert.equal(validate.disabled, true);
  view.setValidating(false);
  assert.equal(validate.disabled, false);
  view.setCommitEnabled(true);
  assert.equal(commit.disabled, false);
  view.setDraftMode(false);
  assert.equal(commit.hidden, true);
  view.destroy();
});
