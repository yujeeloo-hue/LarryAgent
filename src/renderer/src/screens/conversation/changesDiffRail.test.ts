import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { DiffLine } from "./cards/diffTypes.js";
import type { SideBySideRow } from "./cards/sideBySidePair.js";
import { planChangesRail, mountChangesRail, type ChangesRailHunk } from "./changesDiffRail.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  localStorage: { getItem: () => null, setItem: () => {} },
});

const equal = (text: string, line: number): DiffLine => ({ kind: "equal", text, oldLine: line, newLine: line });
const del = (text: string, oldLine: number): DiffLine => ({ kind: "del", text, oldLine, newLine: null });
const add = (text: string, newLine: number): DiffLine => ({ kind: "add", text, oldLine: null, newLine });

function rows(lines: DiffLine[]): SideBySideRow[] {
  const out: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "equal") {
      out.push({ kind: "equal", left: line, right: line });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    const pairs = Math.max(dels.length, adds.length);
    for (let k = 0; k < pairs; k += 1) {
      out.push({ kind: "change", left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return out;
}

/** Mirrors the sample a file diff produces: two changed regions around unchanged context. */
const SAMPLE_ROWS = rows([
  equal("const a = 1;", 1),
  equal("const b = 2;", 2),
  equal("const c = 3;", 3),
  del("const d = 4;", 4),
  add("const d = 40;", 4),
  add("const e = 5;", 5),
  equal("const f = 6;", 6),
  equal("const g = 7;", 7),
  equal("const h = 8;", 8),
  equal("const i = 9;", 9),
  del("const j = 10;", 10),
  equal("const k = 11;", 11),
]);

function railHarness(initial: readonly ChangesRailHunk[]) {
  document.body.replaceChildren();
  const scroller = document.createElement("div");
  scroller.className = "workspace-changes-preview-body";
  const rail = document.createElement("div");
  rail.className = "workspace-changes-rail";
  document.body.append(scroller, rail);
  const scrolled: Array<{ top: number; behavior?: string }> = [];
  (scroller as unknown as { scrollTo: (options: { top: number; behavior?: string }) => void }).scrollTo = (options) => {
    if (typeof options?.top === "number") scrolled.push(options);
  };
  let host: HTMLElement | null = null;
  const binding = mountChangesRail({ rail, scroller, getRowsHost: () => host });
  binding.render(initial);
  return {
    rail, scroller, binding, scrolled,
    setHost: (next: HTMLElement | null) => { host = next; },
    marks: () => Array.from(rail.querySelectorAll(".workspace-changes-rail-mark")) as HTMLElement[],
  };
}

test("unchanged rows are skipped and every hunk reports its kind, counts and lines", () => {
  const hunks = planChangesRail(SAMPLE_ROWS);
  assert.deepEqual(hunks.map(({ kind, row, rowCount, added, removed, startLine, endLine }) => ({ kind, row, rowCount, added, removed, startLine, endLine })), [
    { kind: "modify", row: 3, rowCount: 2, added: 2, removed: 1, startLine: 4, endLine: 5 },
    { kind: "remove", row: 9, rowCount: 1, added: 0, removed: 1, startLine: 10, endLine: 10 },
  ]);
  assert.equal(hunks[0]!.sample, "const d = 40;");
  assert.deepEqual(hunks.map(hunk => [Number(hunk.top.toFixed(4)), Number(hunk.height.toFixed(4))]), [
    [0.2727, 0.1818],
    [0.8182, 0.0909],
  ]);
  assert.deepEqual(planChangesRail(rows([equal("only context", 1)])), []);
  assert.deepEqual(planChangesRail([]), []);
});

test("the rail paints a marker per hunk and hides itself when nothing changed", () => {
  const hunks = planChangesRail(SAMPLE_ROWS);
  const h = railHarness(hunks);
  try {
    assert.equal(h.rail.hidden, false);
    const marks = h.marks();
    assert.equal(marks.length, 2);
    assert.match(marks[0]!.className, /is-modify/);
    assert.match(marks[1]!.className, /is-remove/);
    assert.equal(marks[0]!.style.top, "27.2727%");
    assert.equal(marks[0]!.style.height, "18.1818%");
    assert.equal(marks[0]!.getAttribute("aria-label"), "L4–5 +2 −1");
    assert.equal(marks[1]!.getAttribute("aria-label"), "L10 −1");
    // no scrollbar-looking viewport box: the rail is only marks
    assert.equal(h.rail.querySelectorAll(".workspace-changes-rail-window").length, 0);
    // linkedom has no scrollbar width → offset collapses to 0, never NaN
    assert.equal(h.rail.style.right, "0px");
    h.binding.render([]);
    assert.equal(h.marks().length, 0);
    assert.equal(h.rail.hidden, true);
  } finally { h.binding.dispose(); }
});

test("hovering a marker previews the hunk and highlights both panes", () => {
  const h = railHarness(planChangesRail(SAMPLE_ROWS));
  const sbs = document.createElement("div");
  sbs.className = "tool-file-sbs";
  const left = document.createElement("div");
  left.className = "tool-file-sbs-pane";
  const right = document.createElement("div");
  right.className = "tool-file-sbs-pane";
  sbs.append(left, right);
  for (let i = 0; i < SAMPLE_ROWS.length; i += 1) {
    left.append(document.createElement("div"));
    right.append(document.createElement("div"));
  }
  h.setHost(sbs);
  try {
    const mark = h.marks()[0]!;
    mark.dispatchEvent(new dom.window.Event("mouseenter"));
    const card = h.rail.querySelector(".workspace-changes-rail-card") as HTMLElement;
    assert.equal(card.classList.contains("is-visible"), true);
    const spans = card.querySelectorAll(".workspace-changes-rail-card-head span");
    assert.equal((spans[0] as HTMLElement).textContent, "L4–5");
    assert.equal((spans[1] as HTMLElement).textContent, "+2");
    assert.equal((spans[2] as HTMLElement).textContent, "−1");
    assert.equal((card.querySelector(".workspace-changes-rail-card-code") as HTMLElement).textContent, "const d = 40;");
    // rows 3..5 of both panes carry the highlight
    const hitRows = Array.from(sbs.querySelectorAll(".is-rail-hit")).map(el => {
      const pane = el.parentElement as HTMLElement;
      return Array.from(pane.children).indexOf(el as never);
    });
    assert.deepEqual(hitRows, [3, 4, 3, 4]);
    mark.dispatchEvent(new dom.window.Event("mouseleave"));
    assert.equal(card.classList.contains("is-visible"), false);
    assert.equal(sbs.querySelectorAll(".is-rail-hit").length, 0);
  } finally { h.binding.dispose(); }
});

test("clicking a marker scrolls the preview to that hunk and keeps the highlight", () => {
  const h = railHarness(planChangesRail(SAMPLE_ROWS));
  try {
    const mark = h.marks()[1]!;
    mark.click();
    assert.equal(h.scrolled.length, 1);
    assert.equal(h.scrolled[0]!.behavior, "smooth");
    // no measurable row element (linkedom) → falls back to the document fraction
    assert.equal(h.scrolled[0]!.top, 0);
  } finally { h.binding.dispose(); }
});

test("the changes window renders the side-by-side preview without folding and with the rail", async () => {
  const { WorkspaceChangesController } = await import("./WorkspaceChangesController.js");
  const workspacePath = "/workspace/Atlas";
  const lines = [
    "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
  ];
  const after = lines.map(line => (line === "five" ? "five changed" : line)).join("\n") + "\n";
  const bridge = {
    listWorkingTreeChanges: async () => ({
      files: [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 1, binary: false }],
    }),
    getWorkingTreePathDiff: async () => ({ binary: false, before: lines.join("\n") + "\n", after, truncated: false }),
    closeWorkspaceChangesWindow: async () => {},
  };
  Object.assign(window as unknown as { jellybot?: unknown }, { jellybot: bridge });

  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const controller = new WorkspaceChangesController();
  controller.mount(host as unknown as HTMLElement);
  controller.setWorkspacePath(workspacePath);
  await new Promise(resolve => setTimeout(resolve, 30));

  const root = host as unknown as HTMLElement;
  // unified view first: no rail, no side-by-side panes
  assert.equal(root.querySelector(".workspace-changes-rail")?.hasAttribute("hidden"), true);
  assert.equal(root.querySelectorAll(".tool-file-sbs-pane").length, 0);

  const compare = root.querySelector(".workspace-changes-chrome-preview button[aria-pressed]") as HTMLElement;
  compare.click();
  await new Promise(resolve => setTimeout(resolve, 30));

  const rail = root.querySelector(".workspace-changes-rail") as HTMLElement;
  const marks = Array.from(rail.querySelectorAll(".workspace-changes-rail-mark"));
  assert.equal(rail.hidden, false);
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.getAttribute("aria-label"), "L5 +1 −1");
  assert.equal(root.querySelectorAll(".tool-file-sbs-pane").length, 2);
  // folding stays out of the side-by-side view
  assert.equal(root.querySelectorAll(".tool-file-fold").length, 0);
  assert.equal(root.querySelector(".workspace-changes-preview-main .workspace-changes-rail"), rail);

  delete (window as { jellybot?: unknown }).jellybot;
});
