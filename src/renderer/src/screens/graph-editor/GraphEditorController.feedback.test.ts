import assert from "node:assert/strict";
import Module from "node:module";
import { before, it } from "node:test";
import { parseHTML } from "linkedom";
import type { GraphIssue, GraphValidation } from "../../../../agent/fsm/authoring/diagnostics.js";
import type { GraphEditorView, GraphEditorViewCallbacks } from "./GraphEditorView.js";
import type { GraphEditorNotice } from "./GraphEditorFeedback.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.includes("?raw")) return "";
  if (request.endsWith(".svg")) return request;
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });
let GraphEditorController: typeof import("./GraphEditorController.js").GraphEditorController;
before(async () => { ({ GraphEditorController } = await import("./GraphEditorController.js")); });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const issue: GraphIssue = { code: "ACTION_PREREQUISITE_MISSING", severity: "error", stage: "actions", path: "nodes[1].actions[0]", nodeId: "reviewer", actionId: "call-model", message: "Missing model window", suggestion: "Insert BuildModelWindow." };
const validation: GraphValidation = { valid: false, fingerprint: "first", errors: 1, warnings: 0, issues: [issue], scope: "Static checks" };

async function mount() {
  let callbacks: Partial<GraphEditorViewCallbacks> = {};
  let name = "Review";
  let color = "#a78bfa";
  let rendered: FsmGraphConfigJson | null = null;
  let commitEnabled = false;
  let validating = false;
  const notices: GraphEditorNotice[] = [];
  const reports: GraphValidation[] = [];
  const revealed: string[] = [];
  const view = {
    root: document.createElement("div"),
    setCallbacks: (value: Partial<GraphEditorViewCallbacks>) => { callbacks = value; },
    clearFeedback: () => {},
    showFeedback: (notice: GraphEditorNotice) => notices.push(notice),
    showValidation: (report: GraphValidation) => reports.push(report),
    setDraftMode: () => {},
    setCommitEnabled: (enabled: boolean) => { commitEnabled = enabled; },
    setValidating: (value: boolean) => { validating = value; },
    setGraphName: (value: string) => { name = value; },
    getGraphName: () => name,
    setGraphColor: (value: string) => { color = value; },
    getGraphColor: () => color,
    updateCanvas: (config: FsmGraphConfigJson) => { rendered = config; return {}; },
    setInspector: () => {},
    buildInspectorShell: () => ({ shell: document.createElement("div"), paramsFormHost: null }),
    setActionOverlay: () => {},
    hideActionOverlay: () => {},
    revealNode: (id: string) => revealed.push(id),
    focusShell: () => {},
    destroy: () => {},
  };
  const record: FsmGraphLibraryRecord = {
    id: "test-graph", name, origin: "llm", enabled: false, createdAt: 1, updatedAt: 1, validation,
    config: { version: 2, entryNodeId: "start", terminalNodeId: "end", nodes: [{ id: "start", actions: [] }, { id: "reviewer", name: "Reviewer", actions: [{ type: "NodeActionCallModel" }] }, { id: "end", actions: [] }], edges: [] },
  };
  const bridge = {
    getFsmGraph: async () => structuredClone(record),
    fsmActionCatalog: async () => [],
    analyzeFsmGraph: async (_config: FsmGraphConfigJson) => validation,
    saveFsmGraph: async (value: FsmGraphLibraryRecord) => ({ ...value, validation }),
  };
  Object.assign(window, { jellybot: bridge });
  const controller = new GraphEditorController(view as unknown as GraphEditorView, { graphId: record.id, onBack: () => {} });
  controller.mount();
  await flush(); await flush();
  return { callbacks, controller, bridge, record, notices, reports, revealed, rendered: () => rendered!, commitEnabled: () => commitEnabled, validating: () => validating };
}

it("validates through the bridge and locates a reported action", async () => {
  const app = await mount();
  try {
    assert.equal(app.reports.length, 0, "loading stays quiet");
    app.callbacks.onValidate!(); await flush();
    assert.equal(app.reports[0], validation);
    assert.equal(app.validating(), false);
    assert.equal(app.commitEnabled(), false);
    assert.equal(app.notices.at(-1)!.tone, "loading");
    assert.equal(app.callbacks.onLocateIssue!(issue), true);
    assert.deepEqual(app.revealed, ["reviewer"]);
  } finally { app.controller.destroy(); }
});

it("ignores a stale validation response after the graph changes", async () => {
  const app = await mount();
  try {
    let finish!: (report: GraphValidation) => void;
    app.bridge.analyzeFsmGraph = () => new Promise(resolve => { finish = resolve; });
    app.callbacks.onValidate!();
    app.callbacks.onLocateIssue!(issue);
    app.callbacks.onSelfLoopChange!(true);
    finish({ ...validation, valid: true, errors: 0, issues: [] }); await flush();
    assert.equal(app.reports.length, 0);
    assert.equal(app.commitEnabled(), false);
    assert.equal(app.validating(), false);
  } finally { app.controller.destroy(); }
});

it("retries a failed save using the current graph", async () => {
  const app = await mount();
  try {
    let attempts = 0;
    app.bridge.saveFsmGraph = async value => { if (++attempts === 1) throw new Error("Storage unavailable"); return { ...value, validation }; };
    app.callbacks.onSave!(); await flush();
    const error = app.notices.at(-1)!;
    assert.equal(error.tone, "error");
    assert.equal(error.action!.label, "Retry");
    error.action!.run(); await flush();
    assert.equal(attempts, 2);
    assert.equal(app.notices.at(-1)!.tone, "success");
  } finally { app.controller.destroy(); }
});

it("preserves edits made while a save is in flight", async () => {
  const app = await mount();
  try {
    let finish!: (record: FsmGraphLibraryRecord) => void;
    let submitted!: FsmGraphLibraryRecord;
    app.bridge.saveFsmGraph = value => { submitted = value; return new Promise(resolve => { finish = resolve; }); };
    app.callbacks.onSave!();
    app.callbacks.onLocateIssue!(issue);
    app.callbacks.onSelfLoopChange!(true);
    finish({ ...submitted, validation }); await flush();
    assert.equal(app.rendered().nodes[1]!.selfLoop, true);
    assert.equal(app.notices.at(-1)!.description, "Newer edits are still unsaved.");
  } finally { app.controller.destroy(); }
});
