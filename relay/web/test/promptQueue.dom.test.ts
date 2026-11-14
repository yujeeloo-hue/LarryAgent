/**
 * DOM tests: web PromptQueueView (Mac PromptQueueView parity) — zebra rows
 * render from a full snapshot, the promote button is the only path into
 * mid-turn insertion (and flips to cancel-armed), inline editing commits via
 * the mutation handlers, and the idle palette drives button wording.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
}));

const { PromptQueueView, queuedPromptToViewItem } = await import("../src/promptQueue.js");

type Ops = {
  removed: string[];
  updated: Array<{ id: string; text: string }>;
  moved: string[];
  promoted: string[];
  deferred: string[];
};

function mount(items: Parameters<PromptQueueView["setItems"]>[0] = []) {
  const ops: Ops = { removed: [], updated: [], moved: [], promoted: [], deferred: [] };
  const view = new PromptQueueView();
  view.setHandlers({
    onRemove: (id) => ops.removed.push(id),
    onUpdateText: (id, text) => ops.updated.push({ id, text }),
    onMoveToFront: (id) => ops.moved.push(id),
    onPromote: (id) => ops.promoted.push(id),
    onDefer: (id) => ops.deferred.push(id),
  });
  view.setItems(items);
  document.body.append(view.root);
  return { view, ops };
}

const item = (id: string, text: string, mode: "deferred" | "interrupt" = "deferred") => ({
  id,
  text,
  attachments: [] as Array<{ name: string }>,
  mode,
});

test("empty queue stays folded (hidden)", () => {
  const { view } = mount();
  assert.equal(view.root.hidden, true);
  assert.equal(view.isOpen(), false);
});

test("snapshot renders one row per item with count + mode encoding", () => {
  const { view } = mount([item("a", "first"), item("b", "interrupt me", "interrupt")]);
  assert.equal(view.root.hidden, false);
  assert.equal(view.isOpen(), true);
  const rows = view.root.querySelectorAll(".prompt-queue-row");
  assert.equal(rows.length, 2);
  assert.equal((rows[0] as HTMLElement).dataset.mode, "deferred");
  assert.equal((rows[1] as HTMLElement).dataset.mode, "interrupt");
  assert.match(view.root.querySelector(".prompt-queue-head-count")?.textContent ?? "", /2/);
  // Running turn with an armed prompt shows the interrupt state.
  assert.match(
    view.root.querySelector(".prompt-queue-head-hint")?.textContent ?? "",
    /interrupting this turn/,
  );
});

test("promote button fires onPromote; armed row flips to onDefer", () => {
  const { view, ops } = mount([item("a", "first"), item("b", "armed", "interrupt")]);
  const rows = [...view.root.querySelectorAll(".prompt-queue-row")] as HTMLElement[];
  const promoteBtn = rows[0]!.querySelector<HTMLButtonElement>(".is-promote:not(.is-armed)");
  assert.ok(promoteBtn, "deferred row shows an insert-now button");
  promoteBtn!.click();
  assert.deepEqual(ops.promoted, ["a"]);

  const armedBtn = rows[1]!.querySelector<HTMLButtonElement>(".is-promote.is-armed");
  assert.ok(armedBtn, "interrupt row shows a cancel-insert button");
  armedBtn!.click();
  assert.deepEqual(ops.deferred, ["b"]);
});

test("idle session: hint + labels + send-now wording flip", () => {
  const { view } = mount([item("a", "first")]);
  view.setSessionIdle(true);
  assert.ok(view.root.classList.contains("is-idle"));
  assert.match(
    view.root.querySelector(".prompt-queue-head-hint")?.textContent ?? "",
    /send or edit below/,
  );
  const label = view.root.querySelector(".prompt-queue-row-state")?.textContent ?? "";
  assert.match(label, /Ready to send/);
  const promote = view.root.querySelector<HTMLButtonElement>(".is-promote");
  assert.equal(promote?.getAttribute("aria-label"), "Send this message now");
});

test("move-to-front only exists beyond the head of a multi-item queue", () => {
  const { view, ops } = mount([item("a", "first"), item("b", "second")]);
  const rows = [...view.root.querySelectorAll(".prompt-queue-row")] as HTMLElement[];
  assert.equal(rows[0]!.querySelectorAll("[aria-label='Move to front of queue']").length, 0);
  rows[1]!.querySelector<HTMLButtonElement>("[aria-label='Move to front of queue']")!.click();
  assert.deepEqual(ops.moved, ["b"]);
});

test("inline edit: text button opens the editor, Enter commits via onUpdateText", () => {
  const { view, ops } = mount([item("a", "first")]);
  view.root.querySelector<HTMLButtonElement>(".prompt-queue-row-text")!.click();
  // setItems/render rebuilds the tree — re-query the live row.
  const row = view.root.querySelector(".prompt-queue-row") as HTMLElement;
  const editor = row.querySelector<HTMLTextAreaElement>(".prompt-queue-edit");
  assert.ok(editor, "row switches into an inline textarea");
  editor!.value = "edited";
  // linkedom has no KeyboardEvent constructor — a plain Event with a key.
  const enter = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
  (enter as unknown as { key: string }).key = "Enter";
  editor!.dispatchEvent(enter);
  assert.deepEqual(ops.updated, [{ id: "a", text: "edited" }]);
});

test("remove button fires onRemove without opening the editor", () => {
  const { view, ops } = mount([item("a", "first")]);
  const remove = view.root.querySelector<HTMLButtonElement>("[aria-label='Remove queued message']")!;
  assert.equal(remove.className, "prompt-queue-action-btn", "square Remove keeps its original component appearance");
  remove.click();
  assert.deepEqual(ops.removed, ["a"]);
  assert.equal(view.root.querySelector(".prompt-queue-edit"), null);
});

test("queuedPromptToViewItem maps the device snapshot shape", () => {
  const mapped = queuedPromptToViewItem({
    id: "q1",
    userText: "hello",
    attachments: [{ name: "a.png" }, { name: "b.txt" }],
    mode: "interrupt",
  });
  assert.deepEqual(mapped, {
    id: "q1",
    text: "hello",
    attachments: [{ name: "a.png" }, { name: "b.txt" }],
    mode: "interrupt",
  });
  assert.equal(
    queuedPromptToViewItem({ id: "legacy", userText: "x", attachments: [], mode: "steer" }).mode,
    "interrupt",
    "legacy snapshots retain their armed state",
  );
  assert.equal(
    queuedPromptToViewItem({ id: "q2", userText: "x", attachments: [], mode: "weird" }).mode,
    "deferred",
    "unknown modes normalize to deferred",
  );
});
