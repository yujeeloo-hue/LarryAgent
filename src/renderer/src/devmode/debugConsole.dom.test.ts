/**
 * DOM tests: Debug Console rendering.
 *
 * Attaching to Unreal reports thousands of DAP messages. Rebuilding the whole
 * list per row is quadratic and freezes the renderer (file tree, editor search
 * and every button stop responding), so appends must reuse existing row nodes
 * and coalesce into one DOM write per frame.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const frames: Array<() => void> = [];
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  requestAnimationFrame: (cb: () => void) => frames.push(cb),
  cancelAnimationFrame: () => undefined,
});

type DebugConsoleViewT = typeof import("./DebugConsoleView.js")["DebugConsoleView"];
type DebugConsoleControllerT =
  typeof import("./DebugConsoleController.js")["DebugConsoleController"];
let DebugConsoleView: DebugConsoleViewT;
let DebugConsoleController: DebugConsoleControllerT;

test.before(async () => {
  ({ DebugConsoleView } = await import("./DebugConsoleView.js"));
  ({ DebugConsoleController } = await import("./DebugConsoleController.js"));
});

type Row = { timestamp: number; direction: "send" | "receive" | "error"; text: string };
type Payload = { workspacePath: string; entries: Row[] };

function runFrames(): number {
  const queued = frames.splice(0, frames.length);
  for (const cb of queued) cb();
  return queued.length;
}

function mount(): {
  view: InstanceType<DebugConsoleViewT>;
  controller: InstanceType<DebugConsoleControllerT>;
  emit: (entries: Row[]) => void;
} {
  frames.length = 0;
  let listener: (payload: Payload) => void = () => undefined;
  (globalThis as unknown as { window: Record<string, unknown> }).window.jellybot = {
    onDebugOutput: (handler: (payload: Payload) => void) => {
      listener = handler;
      return () => undefined;
    },
    onDebugState: () => () => undefined,
    getDebugState: () => Promise.resolve({ console: [] }),
  };
  const view = new DebugConsoleView();
  const controller = new DebugConsoleController(view);
  controller.mount();
  runFrames();
  return {
    view,
    controller,
    emit: (entries) => listener({ workspacePath: "E:/proj", entries }),
  };
}

function rows(view: InstanceType<DebugConsoleViewT>): Element[] {
  return [...view.root.querySelectorAll(".devmode-debug-console-row")];
}

function batch(count: number, offset = 0): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1_000 + offset + i,
    direction: "receive" as const,
    text: `event module #${offset + i}`,
  }));
}

test("appending trace rows keeps existing row nodes", () => {
  const { view, emit } = mount();
  emit(batch(3));
  runFrames();
  const first = rows(view);
  assert.equal(first.length, 3);

  emit(batch(2, 3));
  runFrames();
  const second = rows(view);
  assert.equal(second.length, 5);
  // Same node identity = no full rebuild. Rebuilding is what made Unreal
  // attach quadratic.
  for (let i = 0; i < first.length; i += 1) {
    assert.equal(second[i], first[i]);
  }
});

test("a burst of entries paints once per frame", () => {
  const { view, emit } = mount();
  emit(batch(200));
  emit(batch(200, 200));
  assert.equal(runFrames(), 1, "one coalesced frame for both flushes");
  assert.equal(rows(view).length, 400);
});

test("the rendered list is capped", () => {
  const { view, emit } = mount();
  for (let sent = 0; sent < 4_000; sent += 500) {
    emit(batch(500, sent));
    runFrames();
  }
  assert.equal(rows(view).length, 3_000);
  const last = rows(view).at(-1);
  assert.match(last?.textContent ?? "", /#3999/);
});

test("filtering still re-evaluates every row", () => {
  const { view, emit } = mount();
  emit([
    { timestamp: 1, direction: "receive", text: "event module alpha" },
    { timestamp: 2, direction: "receive", text: "event stopped beta" },
  ]);
  runFrames();
  assert.equal(rows(view).length, 2);

  view.onFilterChange?.("beta");
  const filtered = rows(view);
  assert.equal(filtered.length, 1);
  assert.match(filtered[0]?.textContent ?? "", /beta/);

  view.onFilterChange?.("");
  assert.equal(rows(view).length, 2);
});

test("clearing drops rendered and pending output while future messages still arrive", () => {
  const { view, controller, emit } = mount();
  emit(batch(2));
  runFrames();
  emit(batch(2, 2));
  controller.clear();
  runFrames();
  assert.equal(rows(view).length, 0);
  assert.match(view.root.textContent ?? "", /Program output and debugger messages/);
  emit(batch(1, 4));
  runFrames();
  assert.equal(rows(view).length, 1);
  assert.match(rows(view)[0]?.textContent ?? "", /#4/);
});

test("copy button flashes Copied then restores", () => {
  const view = new DebugConsoleView();
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    timeouts.push({ fn, ms: ms ?? 0 });
    return timeouts.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
  try {
    view.flashCopied();
    assert.equal(view.copyButton.title, "Copied");
    assert.equal(view.copyButton.getAttribute("aria-label"), "Copied");
    assert.ok(view.copyButton.classList.contains("is-copied"));
    assert.equal(timeouts[0]?.ms, 1_200);
    timeouts[0]?.fn();
    assert.equal(view.copyButton.title, "Copy all");
    assert.ok(!view.copyButton.classList.contains("is-copied"));
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
