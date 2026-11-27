import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

let VirtualList: typeof import("./virtualList.js")["VirtualList"];
let BuildLogModel: typeof import("./buildLogModel.js")["BuildLogModel"];
let BuildOutputView: typeof import("./BuildOutputView.js")["BuildOutputView"];
let BuildProblemsView: typeof import("./BuildProblemsView.js")["BuildProblemsView"];
let parseBuildDiagnostic: typeof import("./buildDiagnostics.js")["parseBuildDiagnostic"];

test.before(async () => {
  ({ VirtualList } = await import("./virtualList.js"));
  ({ BuildLogModel } = await import("./buildLogModel.js"));
  ({ BuildOutputView } = await import("./BuildOutputView.js"));
  ({ BuildProblemsView } = await import("./BuildProblemsView.js"));
  ({ parseBuildDiagnostic } = await import("./buildDiagnostics.js"));
});

function scrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  el.dispatchEvent(new window.Event("scroll"));
}

test("a long build log keeps a bounded window of rows pinned to the tail", () => {
  const model = new BuildLogModel();
  const view = new BuildOutputView(model);
  for (let i = 0; i < 10_000; i++) model.appendOutput(`[${i}/10000] Compile Module${i}.cpp\n`);
  const lines = [...view.root.querySelectorAll(".terminal-pane-chunk")];
  assert.ok(lines.length > 0 && lines.length < 100, `rendered ${lines.length}`);
  assert.match(lines.at(-1)?.textContent ?? "", /Module9999\.cpp/);
  const sizer = view.root.querySelector<HTMLElement>(".virtual-list-sizer")!;
  assert.ok(Number.parseFloat(sizer.style.height) >= 10_000 * 17, "the scroll extent covers every line");
  view.destroy();
});

test("scrolling up stops following the tail and recycles detached rows", () => {
  const model = new BuildLogModel();
  const view = new BuildOutputView(model);
  for (let i = 0; i < 2_000; i++) model.appendOutput(`line ${i}\n`);
  const tail = new Set(view.root.querySelectorAll(".terminal-pane-chunk"));
  scrollTo(view.root, 0);
  const head = [...view.root.querySelectorAll(".terminal-pane-chunk")];
  assert.equal(head[0]?.textContent, "line 0\n");
  assert.ok(head.some((row) => tail.has(row)), "rows are reused, not rebuilt");
  model.appendOutput("line 2000\n");
  assert.equal(view.root.querySelector(".terminal-pane-chunk")?.textContent, "line 0\n", "new output does not yank the view");
  view.destroy();
});

test("a live line rewrites in place without rebinding its neighbours", () => {
  const model = new BuildLogModel();
  const view = new BuildOutputView(model);
  model.appendOutput("head\n", "meta");
  const live = model.openLine("stdout");
  live.set("[1/9] A.cpp");
  const head = view.root.querySelector(".terminal-pane-chunk.is-meta");
  live.set("[2/9] B.cpp", "warning");
  assert.equal(view.root.querySelector(".terminal-pane-chunk.is-meta"), head);
  const row = view.root.querySelector<HTMLElement>(".terminal-pane-chunk.is-stdout")!;
  assert.equal(row.textContent, "[2/9] B.cpp");
  assert.equal(row.dataset.buildTone, "warning");
  view.destroy();
});

test("trimming the head keeps the surviving row nodes", () => {
  const host = document.createElement("div");
  let items = Array.from({ length: 50 }, (_, i) => i);
  const list = new VirtualList(host, {
    count: () => items.length,
    key: (i) => items[i],
    type: () => "row",
    create: () => document.createElement("div"),
    bind: (el, i) => { el.textContent = String(items[i]); },
  }, { rowHeight: 20, followTail: true });
  list.refresh();
  const before = new Map([...host.querySelectorAll("div:not(.virtual-list-sizer):not(.virtual-list-window)")].map((el) => [el.textContent, el]));
  items = items.slice(10).concat([50, 51]);
  list.refresh();
  const after = [...host.querySelectorAll(".virtual-list-window > div")];
  assert.equal(after.at(-1)?.textContent, "51");
  assert.equal(after.find((el) => el.textContent === "40"), before.get("40"));
  list.destroy();
  assert.equal(host.childElementCount, 0);
});

test("thousands of problems render a window, errors first", () => {
  const view = new BuildProblemsView();
  const items = Array.from({ length: 3_000 }, (_, i) => parseBuildDiagnostic(`A.cpp(${i + 1}): warning C4100: unused ${i}`)!);
  view.append(items);
  view.append([parseBuildDiagnostic("B.cpp(1): error C2065: missing")!]);
  const rows = [...view.root.querySelectorAll<HTMLElement>(".devmode-build-problem")];
  assert.ok(rows.length < 60, `rendered ${rows.length}`);
  assert.equal(rows[0]?.dataset.severity, "error");
  assert.equal(view.root.querySelector('[aria-label="3000 warnings"]')?.textContent, "3000");
  view.destroy();
});
