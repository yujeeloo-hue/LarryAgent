import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { parseHTML } from "linkedom";
import type { TokenHubController } from "../src/TokenHubController.js";
import { bindProviderReorder, syncProviderRows } from "../src/tokenHubReorder.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
});

// linkedom does not implement browser focus or KeyboardEvent. Track focus so
// moving existing nodes still exercises the module's preventScroll contract.
let focused: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });

function fixture() {
  document.body.innerHTML = `<section class="token-hub-body">
    <aside class="th-rail"><div class="th-provider-list" role="listbox">
      <div class="th-provider-row" data-provider-id="a" role="option" aria-selected="false"><button class="th-provider-grip">A</button></div>
      <div class="th-provider-row is-selected" data-provider-id="b" role="option" aria-selected="true"><button class="th-provider-grip">B</button></div>
      <div class="th-provider-row" data-provider-id="c" role="option" aria-selected="false"><button class="th-provider-grip">C</button></div>
    </div><span class="th-order-status" role="status"></span></aside>
    <section class="th-detail"><input class="th-name-input" aria-label="Provider name"><input type="checkbox" aria-label="Image support"><textarea aria-label="Notes"></textarea></section>
  </section>`;
  focused = null;
  const list = document.querySelector<HTMLElement>(".th-provider-list")!;
  const status = document.querySelector<HTMLElement>(".th-order-status")!;
  const detail = document.querySelector<HTMLElement>(".th-detail")!;
  const draft = detail.querySelector<HTMLInputElement>(".th-name-input")!;
  const multimodal = detail.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const notes = detail.querySelector<HTMLTextAreaElement>("textarea")!;
  draft.value = "Unsaved provider name";
  notes.value = "Unsaved notes";
  const original = [...list.querySelectorAll<HTMLElement>(".th-provider-row")];
  const grip = original[1]!.querySelector<HTMLButtonElement>("button")!;
  const focusCalls: Array<FocusOptions | undefined> = [];
  grip.focus = (options?: FocusOptions) => { focused = grip; focusCalls.push(options); };
  focused = grip;
  list.scrollTop = 137;
  return { list, status, detail, draft, multimodal, notes, original, grip, focusCalls };
}

function order(list: HTMLElement): string[] {
  return [...list.querySelectorAll<HTMLElement>(".th-provider-row")].map((row) => row.dataset.providerId!);
}

function keyboard(target: HTMLElement, key: string, altKey = true): Event {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, { key, altKey });
  target.dispatchEvent(event);
  return event;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function controllerStub() {
  let ids = ["a", "b", "c"];
  let busy = false;
  const gate = deferred();
  const gates = [gate];
  const requests: string[][] = [];
  let onApply = () => {};
  const controller = {
    isProviderOrderSaving: () => busy,
    getSnapshot: () => ({ providers: ids.map((id) => ({ id })) }),
    reorderProviders: async (next: string[]) => {
      const currentGate = requests.length ? deferred() : gate;
      if (requests.length) gates.push(currentGate);
      requests.push([...next]);
      busy = true;
      try {
        await currentGate.promise;
        ids = [...next];
        busy = false;
        onApply();
      } finally { busy = false; }
    },
  } as unknown as TokenHubController;
  return { controller, requests, gate, gates,
    setBusy: (value: boolean) => { busy = value; },
    onApply: (callback: () => void) => { onApply = callback; },
  };
}

test("syncProviderRows moves existing rows without resetting selection, detail drafts, focus or scroll", () => {
  const view = fixture();
  syncProviderRows(view.list, ["c", "a", "b"]);
  assert.deepEqual(order(view.list), ["c", "a", "b"]);
  assert.deepEqual([...view.list.children], [view.original[2], view.original[0], view.original[1]]);
  assert.equal(view.list.querySelector('[aria-selected="true"]'), view.original[1]);
  assert.equal(view.original[1]!.classList.contains("is-selected"), true);
  assert.equal(document.querySelector(".th-detail"), view.detail);
  assert.equal(view.draft.value, "Unsaved provider name");
  assert.equal(view.notes.value, "Unsaved notes");
  assert.equal(document.activeElement, view.grip);
  assert.deepEqual(view.focusCalls, [{ preventScroll: true }]);
  assert.equal(view.list.scrollTop, 137);
});

test("syncProviderRows leaves rows untouched for an unchanged or incomplete snapshot", () => {
  const view = fixture();
  for (const ids of [["a", "b", "c"], ["a", "b"], ["a", "b", "missing"]]) {
    syncProviderRows(view.list, ids);
    assert.deepEqual([...view.list.children], view.original);
    assert.equal(view.list.scrollTop, 137);
  }
  assert.deepEqual(view.focusCalls, []);
});

test("Alt+Arrow saves the optimistic row order once and keeps the selected provider draft intact", async () => {
  const view = fixture();
  const state = controllerStub();
  bindProviderReorder(view.list, view.status, state.controller);
  const event = keyboard(view.grip, "ArrowUp");
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(order(view.list), ["b", "a", "c"]);
  assert.deepEqual(state.requests, [["b", "a", "c"]]);
  assert.equal(view.status.textContent, "Saving order…");
  assert.equal(view.list.getAttribute("aria-busy"), "true");
  assert.equal(view.list.querySelector('[aria-selected="true"]'), view.original[1]);
  assert.equal(view.draft.value, "Unsaved provider name");
  assert.equal(document.activeElement, view.grip);
  assert.equal(view.list.scrollTop, 137);

  // Additional keyboard input during the unresolved write cannot enqueue a
  // second write or move the DOM away from the order currently being saved.
  keyboard(view.grip, "ArrowDown");
  assert.deepEqual(state.requests, [["b", "a", "c"]]);
  assert.deepEqual(order(view.list), ["b", "a", "c"]);
  state.gate.resolve();
  await setImmediate();
  assert.equal(view.status.textContent, "Order saved");
  assert.equal(view.status.classList.contains("is-error"), false);
  assert.equal(view.list.getAttribute("aria-busy"), "false");
  assert.deepEqual(state.controller.getSnapshot().providers.map((provider) => provider.id), ["b", "a", "c"]);
});

test("ordinary arrow keys and moving beyond either end do not reorder or save", () => {
  const view = fixture();
  const state = controllerStub();
  bindProviderReorder(view.list, view.status, state.controller);
  assert.equal(keyboard(view.grip, "ArrowUp", false).defaultPrevented, false);
  keyboard(view.original[0]!.querySelector<HTMLButtonElement>("button")!, "ArrowUp");
  keyboard(view.original[2]!.querySelector<HTMLButtonElement>("button")!, "ArrowDown");
  assert.deepEqual(order(view.list), ["a", "b", "c"]);
  assert.deepEqual(state.requests, []);
  assert.equal(view.status.textContent, "Drag the grip to reorder");
  assert.deepEqual(view.focusCalls, []);
});

test("the grip stays centered in top-aligned mobile rows and has WebKit selection guards", () => {
  const css = readFileSync(new URL("../src/token-hub.css", import.meta.url), "utf8");
  const grip = css.match(/\.th-provider-grip\s*\{([^}]*)\}/)?.[1] ?? "";
  const reordering = css.match(/\.th-provider-list\.is-reordering\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(grip, /align-self:\s*center;/);
  assert.match(grip, /-webkit-user-select:\s*none;/);
  assert.match(grip, /-webkit-touch-callout:\s*none;/);
  assert.match(reordering, /-webkit-user-select:\s*none;/);
});

test("touch reordering suppresses selection from pointer down until release", () => {
  const view = fixture();
  const state = controllerStub();
  bindProviderReorder(view.list, view.status, state.controller);
  const down = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  Object.assign(down, {
    isPrimary: true, button: 0, pointerId: 7, pointerType: "touch", clientX: 12, clientY: 24,
  });
  view.grip.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(view.list.classList.contains("is-reordering"), true,
    "selection is disabled before the drag movement threshold");
  assert.equal(view.original[1]!.classList.contains("is-drag-source"), false,
    "a press alone does not create a drag ghost");
  assert.deepEqual(state.requests, []);

  const up = new window.Event("pointerup", { bubbles: true, cancelable: true });
  Object.assign(up, { pointerId: 7 });
  window.dispatchEvent(up);
  assert.equal(view.list.classList.contains("is-reordering"), false);
  assert.deepEqual(order(view.list), ["a", "b", "c"]);
  assert.deepEqual(state.requests, []);
});

test("reordering is blocked while another order save or a detail edit is busy", () => {
  for (const reason of ["controller saving", "detail busy"] as const) {
    const view = fixture();
    const state = controllerStub();
    bindProviderReorder(view.list, view.status, state.controller);
    if (reason === "controller saving") state.setBusy(true);
    else view.draft.disabled = true;
    const event = keyboard(view.grip, "ArrowDown");
    assert.equal(event.defaultPrevented, true, reason);
    assert.deepEqual(order(view.list), ["a", "b", "c"], reason);
    assert.deepEqual(state.requests, [], reason);
    assert.equal(view.draft.value, "Unsaved provider name", reason);
  }
});

test("an unsaved detail draft with its image-support checkbox disabled still permits reordering", async () => {
  const view = fixture();
  const state = controllerStub();
  // Image support is disabled while other detail fields are dirty; this does
  // not mean that a detail save or provider-order save is in progress.
  view.multimodal.disabled = true;
  bindProviderReorder(view.list, view.status, state.controller);
  keyboard(view.grip, "ArrowUp");
  assert.deepEqual(state.requests, [["b", "a", "c"]]);
  assert.equal(view.draft.disabled, false);
  assert.equal(view.draft.value, "Unsaved provider name");
  assert.equal(view.multimodal.disabled, true);
  state.gate.resolve();
  await setImmediate();
  assert.equal(view.status.textContent, "Order saved");
});

test("a rejected order rolls the same nodes back, reports the error and permits retry", async () => {
  const view = fixture();
  const state = controllerStub();
  bindProviderReorder(view.list, view.status, state.controller);
  keyboard(view.grip, "ArrowDown");
  assert.deepEqual(order(view.list), ["a", "c", "b"]);
  state.gate.reject(new Error("The relay could not save this order."));
  await setImmediate();
  assert.deepEqual(order(view.list), ["a", "b", "c"]);
  assert.deepEqual([...view.list.children], view.original);
  assert.equal(view.status.textContent, "The relay could not save this order.");
  assert.equal(view.status.classList.contains("is-error"), true);
  assert.equal(view.list.getAttribute("aria-busy"), "false");
  assert.equal(view.list.querySelector('[aria-selected="true"]'), view.original[1]);
  assert.equal(view.draft.value, "Unsaved provider name");
  assert.equal(view.notes.value, "Unsaved notes");
  assert.equal(document.activeElement, view.grip);
  assert.equal(view.list.scrollTop, 137);
  keyboard(view.grip, "ArrowUp");
  assert.equal(state.requests.length, 2, "failed saves release the lock for a retry");
  state.gates[1]!.resolve();
  await setImmediate();
  assert.equal(view.status.textContent, "Order saved");
});

test("a list rebuilt during a successful save receives completion and can save another order", async () => {
  const oldView = fixture();
  const state = controllerStub();
  bindProviderReorder(oldView.list, oldView.status, state.controller);
  keyboard(oldView.grip, "ArrowUp");

  const current = fixture();
  bindProviderReorder(current.list, current.status, state.controller);
  state.onApply(() => syncProviderRows(current.list, state.controller.getSnapshot().providers.map((provider) => provider.id)));
  assert.equal(oldView.list.isConnected, false);
  assert.equal(current.status.textContent, "Saving order…");
  assert.equal(current.list.getAttribute("aria-busy"), "true");
  keyboard(current.grip, "ArrowDown");
  assert.equal(state.requests.length, 1, "the rebuilt rail respects the controller's in-flight lock");

  state.gate.resolve();
  await setImmediate();
  assert.deepEqual(order(current.list), ["b", "a", "c"]);
  assert.equal(current.status.textContent, "Order saved");
  assert.equal(current.list.getAttribute("aria-busy"), "false");
  assert.equal(current.draft.value, "Unsaved provider name");
  keyboard(current.grip, "ArrowDown");
  assert.deepEqual(state.requests, [["b", "a", "c"], ["a", "b", "c"]]);
  state.gates[1]!.resolve();
  await setImmediate();
  assert.equal(current.status.textContent, "Order saved");
  assert.equal(current.list.getAttribute("aria-busy"), "false");
});

test("a list rebuilt during a failed save receives rollback and error, then permits a successful retry", async () => {
  const oldView = fixture();
  const state = controllerStub();
  bindProviderReorder(oldView.list, oldView.status, state.controller);
  keyboard(oldView.grip, "ArrowDown");

  const current = fixture();
  syncProviderRows(current.list, ["a", "c", "b"]);
  bindProviderReorder(current.list, current.status, state.controller);
  assert.equal(current.status.textContent, "Saving order…");
  state.gate.reject(new Error("Order save interrupted."));
  await setImmediate();
  assert.deepEqual(order(current.list), ["a", "b", "c"]);
  assert.deepEqual([...current.list.children], current.original);
  assert.equal(current.status.textContent, "Order save interrupted.");
  assert.equal(current.status.classList.contains("is-error"), true);
  assert.equal(current.list.getAttribute("aria-busy"), "false");
  assert.equal(current.draft.value, "Unsaved provider name");
  assert.equal(document.activeElement, current.grip);
  assert.equal(current.list.scrollTop, 137);

  keyboard(current.grip, "ArrowUp");
  assert.deepEqual(state.requests, [["a", "c", "b"], ["b", "a", "c"]]);
  assert.equal(current.status.classList.contains("is-error"), false);
  state.gates[1]!.resolve();
  await setImmediate();
  assert.equal(current.status.textContent, "Order saved");
  assert.equal(current.list.getAttribute("aria-busy"), "false");
});
