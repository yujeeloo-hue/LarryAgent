import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { PromptQueueItem } from "./PromptQueueView.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });

let PromptQueueView: typeof import("./PromptQueueView.js").PromptQueueView;
test.before(async () => {
  ({ PromptQueueView } = await import("./PromptQueueView.js"));
});

const item = (id: string, text = id): PromptQueueItem => ({
  id, text, attachments: [], mode: "deferred",
});

test("collapsing keeps the count and next prompt available across queue snapshots", () => {
  const view = new PromptQueueView();
  view.setItems([item("first"), item("second")]);
  const toggle = view.root.querySelector<HTMLButtonElement>(".prompt-queue-toggle")!;
  const controlledId = toggle.getAttribute("aria-controls");
  toggle.click();
  assert.equal(view.isOpen(), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(view.root.querySelector<HTMLElement>(".prompt-queue-list")!.inert, true);
  assert.equal(view.root.querySelector<HTMLElement>(".prompt-queue-next")!.hidden, false);
  assert.equal(view.root.querySelector(".prompt-queue-next span")!.textContent, "first");

  view.setItems([item("second"), item("third"), item("fourth")]);
  const updatedToggle = view.root.querySelector<HTMLButtonElement>(".prompt-queue-toggle")!;
  assert.equal(updatedToggle.getAttribute("aria-controls"), controlledId);
  assert.equal(updatedToggle.getAttribute("aria-expanded"), "false");
  assert.equal(view.root.querySelector(".prompt-queue-head-count")!.textContent, "· 3");
  assert.equal(view.root.querySelector(".prompt-queue-next span")!.textContent, "second");
  updatedToggle.click();
  assert.equal(updatedToggle.getAttribute("aria-expanded"), "true");
  assert.equal(view.root.querySelector<HTMLElement>(".prompt-queue-list")!.inert, false);
  assert.equal(view.root.querySelector<HTMLElement>(".prompt-queue-next")!.hidden, true);
  assert.equal(view.root.querySelectorAll(".prompt-queue-row").length, 3);
  view.destroy();
});

test("a new queue expands even when it arrives during the old queue's exit", () => {
  const view = new PromptQueueView();
  view.setItems([item("old")]);
  view.root.querySelector<HTMLButtonElement>(".prompt-queue-toggle")!.click();
  view.setItems([]);
  view.setItems([item("new")]);
  assert.equal(view.isOpen(), true);
  assert.equal(view.root.hidden, false);
  assert.equal(view.root.querySelector(".prompt-queue-toggle")!.getAttribute("aria-expanded"), "true");
  assert.equal(view.root.querySelector(".prompt-queue-row-text")!.textContent, "new");
  view.destroy();
});

test("collapsing an inline edit commits once and keeps queue actions intact", () => {
  const view = new PromptQueueView();
  const updates: Array<[string, string]> = [];
  const removals: string[] = [];
  view.setHandlers({
    onUpdateText: (id, text) => updates.push([id, text]),
    onRemove: (id) => removals.push(id),
    onMoveToFront: () => {}, onPromote: () => {}, onDefer: () => {},
  });
  view.setItems([item("edit")]);
  view.root.querySelector<HTMLButtonElement>(".prompt-queue-row-text")!.click();
  const editor = view.root.querySelector<HTMLTextAreaElement>(".prompt-queue-edit")!;
  editor.setSelectionRange = () => {};
  editor.value = "Updated instructions";
  view.root.querySelector<HTMLButtonElement>(".prompt-queue-toggle")!.click();
  assert.deepEqual(updates, [["edit", "Updated instructions"]]);
  assert.equal(view.root.querySelector(".prompt-queue-toggle")!.getAttribute("aria-expanded"), "false");
  view.root.querySelector<HTMLButtonElement>(".prompt-queue-toggle")!.click();
  view.root.querySelector<HTMLButtonElement>(".is-remove")!.click();
  assert.deepEqual(removals, ["edit"]);
  view.destroy();
});
