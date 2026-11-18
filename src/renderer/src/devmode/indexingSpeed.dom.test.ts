import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { IndexingSpeedControl } from "./IndexingSpeedControl.js";
import { isDevModalOpen } from "./modalLayer.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, Node: dom.Node });
let focused: unknown;
dom.HTMLElement.prototype.focus = function () { focused = this; };
Object.assign(dom.HTMLElement.prototype, { getBoundingClientRect: () => ({ top: 400, right: 700, bottom: 426, width: 26, height: 26 }) });
Object.assign(window, { innerWidth: 800, innerHeight: 600 });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(change: (root: string, speed: string) => Promise<unknown> = async (_root, speed) => ({ ok: true, speed })) {
  const calls: string[][] = [];
  const changes: string[][] = [];
  const errors: string[] = [];
  Object.assign(window, { jellybot: { clangdSetIndexingSpeed: async (root: string, speed: string) => {
    calls.push([root, speed]); return change(root, speed);
  } } });
  const control = new IndexingSpeedControl({ onChanged: (root, speed) => changes.push([root, speed]), onError: message => errors.push(message) });
  document.body.append(control.button);
  return { control, calls, changes, errors, dialog: () => document.querySelector<HTMLElement>('[role="dialog"]') };
}

test("the lightning button is indexing-only; cancel and Escape dismiss without changing speed", () => {
  const h = harness();
  try {
    h.control.update("/Game", false, "normal");
    assert.equal(h.control.button.hidden, true);
    h.control.update("/Game", true, "normal");
    assert.equal(h.control.button.hidden, false);
    h.control.button.click();
    assert.equal(h.dialog()?.getAttribute("aria-label"), "Full-speed indexing?");
    assert.match(h.dialog()?.textContent ?? "", /maximum available resources.*system may slow down and memory usage may increase/);
    assert.equal(isDevModalOpen(), true);
    assert.equal((focused as HTMLElement).textContent, "Cancel");
    h.dialog()!.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(h.dialog(), null);
    h.control.button.click();
    window.dispatchEvent(Object.assign(new dom.window.Event("keydown"), { key: "Escape" }));
    assert.equal(h.dialog(), null);
    assert.equal(isDevModalOpen(), false);
    assert.deepEqual(h.calls, []);
  } finally { h.control.destroy(); }
});

test("confirmation invokes the indexer, prevents duplicate requests, and supports restoring normal speed", async () => {
  let finish!: (value: unknown) => void;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  try {
    h.control.update("/Game", true, "normal");
    h.control.button.click();
    h.dialog()!.querySelector<HTMLButtonElement>(".action-primary")!.click();
    assert.equal(h.dialog(), null);
    assert.equal(h.control.button.disabled, true);
    assert.deepEqual(h.calls, [["/Game", "full"]]);
    finish({ ok: true, speed: "full" }); await settle();
    assert.deepEqual(h.changes, [["/Game", "full"]]);
    h.control.update("/Game", true, "full");
    assert.equal(h.control.button.getAttribute("aria-pressed"), "true");
    h.control.button.click();
    assert.equal(h.dialog()?.getAttribute("aria-label"), "Return to normal speed?");
    assert.equal(h.dialog()!.querySelector<HTMLElement>(".devmode-index-boost-description")!.hidden, true);
    h.dialog()!.querySelector<HTMLButtonElement>(".action-primary")!.click();
    assert.deepEqual(h.calls[1], ["/Game", "normal"]);
    finish({ ok: true, speed: "normal" }); await settle();
    h.control.update("/Game", false, "normal");
    assert.equal(h.control.button.hidden, true);
  } finally { h.control.destroy(); }
});

test("workspace changes dismiss the popup and ignore an old workspace's pending result", async () => {
  let finish!: (value: unknown) => void;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  try {
    h.control.update("/Game", true, "normal");
    h.control.button.click();
    h.control.update("/Other", false, "normal");
    assert.equal(h.dialog(), null);
    h.control.update("/Game", true, "normal");
    h.control.button.click();
    h.dialog()!.querySelector<HTMLButtonElement>(".action-primary")!.click();
    h.control.update("/Other", false, "normal");
    finish({ ok: true, speed: "full" }); await settle();
    assert.deepEqual(h.changes, []);
    assert.equal(h.control.button.hidden, true);
    assert.equal(isDevModalOpen(), false);
  } finally { h.control.destroy(); }
});

test("failed requests keep normal state and show a transient error", async () => {
  const h = harness(async () => ({ ok: false, message: "Indexer unavailable" }));
  try {
    h.control.update("/Game", true, "normal");
    h.control.button.click();
    h.dialog()!.querySelector<HTMLButtonElement>(".action-primary")!.click();
    await settle();
    assert.deepEqual(h.errors, ["Indexer unavailable"]);
    assert.equal(h.control.button.getAttribute("aria-pressed"), "false");
    assert.equal(h.control.button.disabled, false);
  } finally { h.control.destroy(); }
});
