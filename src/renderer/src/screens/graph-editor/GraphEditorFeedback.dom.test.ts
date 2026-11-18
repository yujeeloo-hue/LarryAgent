import assert from "node:assert/strict";
import Module from "node:module";
import { before, it } from "node:test";
import { parseHTML } from "linkedom";
import type { GraphIssue, GraphValidation } from "../../../../agent/fsm/authoring/diagnostics.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, Node: dom.window.Node });
let GraphEditorFeedback: typeof import("./GraphEditorFeedback.js").GraphEditorFeedback;
before(async () => { ({ GraphEditorFeedback } = await import("./GraphEditorFeedback.js")); });

const issue: GraphIssue = { code: "ACTION_PREREQUISITE_MISSING", severity: "error", stage: "actions", path: "nodes[1].actions[2]", nodeId: "reviewer", actionId: "call-model", message: "The model window is missing.", suggestion: "Insert BuildModelWindow earlier in this node." };
const validation: GraphValidation = { valid: false, fingerprint: "version-a", errors: 1, warnings: 0, issues: [issue], scope: "Static checks" };

it("keeps errors persistent, exposes real issues, and locates without adding a canvas bar", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feedback = new GraphEditorFeedback();
  const selected: GraphIssue[] = [];
  feedback.showValidation(validation, target => { selected.push(target); return true; });
  assert.equal(feedback.root.getAttribute("role"), "alert");
  assert.match(feedback.root.textContent!, /1 error and 0 warnings/);
  t.mock.timers.tick(10000);
  assert.equal(feedback.root.hidden, false);
  const toggle = feedback.root.querySelector<HTMLButtonElement>(".graph-editor-feedback-action")!;
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  feedback.root.querySelector<HTMLButtonElement>(".graph-editor-feedback-issue")!.click();
  assert.deepEqual(selected, [issue]);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(feedback.root.hidden, false);
  feedback.root.querySelector<HTMLButtonElement>(".graph-editor-feedback-close")!.click();
  assert.equal(feedback.root.hidden, true);
  feedback.destroy();
});

it("auto-dismisses success and replaces old notices without stale timers hiding errors", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feedback = new GraphEditorFeedback();
  feedback.show({ tone: "success", title: "Draft saved" });
  t.mock.timers.tick(3499);
  assert.equal(feedback.root.hidden, false);
  t.mock.timers.tick(1);
  assert.equal(feedback.root.hidden, true);
  feedback.show({ tone: "success", title: "Saved" });
  feedback.show({ tone: "error", title: "Couldn’t save", source: "save" });
  t.mock.timers.tick(10000);
  assert.equal(feedback.root.hidden, false);
  assert.equal(feedback.root.querySelectorAll(".graph-editor-feedback-head").length, 1);
  feedback.dismiss("validation");
  assert.equal(feedback.root.hidden, false, "quiet background validation must not dismiss a save error");
  feedback.destroy();
});

it("pauses transient notices while hovered and resumes the remaining duration", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const feedback = new GraphEditorFeedback();
  feedback.show({ tone: "info", title: "Export ready" });
  t.mock.timers.tick(1000);
  feedback.root.dispatchEvent(new dom.window.Event("mouseenter"));
  t.mock.timers.tick(10000);
  assert.equal(feedback.root.hidden, false);
  feedback.root.dispatchEvent(new dom.window.Event("mouseleave"));
  t.mock.timers.tick(2499);
  assert.equal(feedback.root.hidden, false);
  t.mock.timers.tick(1);
  assert.equal(feedback.root.hidden, true);
  feedback.destroy();
});

it("shows non-blocking warnings and supports retrying a failed save", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feedback = new GraphEditorFeedback();
  feedback.showValidation({ ...validation, valid: true, errors: 0, warnings: 1, issues: [{ ...issue, severity: "warning" }] }, () => false);
  assert.equal(feedback.root.dataset.tone, "warning");
  assert.match(feedback.root.textContent!, /You can enable this graph/);
  let retries = 0;
  feedback.show({ tone: "error", title: "Couldn’t save the graph", action: { label: "Retry", run: () => { retries++; feedback.show({ tone: "success", title: "Draft saved" }); } } });
  feedback.root.querySelector<HTMLButtonElement>(".graph-editor-feedback-action")!.click();
  assert.equal(retries, 1);
  assert.equal(feedback.root.dataset.tone, "success");
  feedback.destroy();
  t.mock.timers.tick(10000);
  assert.equal(feedback.root.childElementCount, 0);
});
