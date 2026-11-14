import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";
import type { ToolStatsSummaryRow } from "./ToolStatsPaneView.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document, window });
let ToolStatsPaneView: typeof import("./ToolStatsPaneView.js").ToolStatsPaneView;
before(async () => { ({ ToolStatsPaneView } = await import("./ToolStatsPaneView.js")); });

const rows: ToolStatsSummaryRow[] = [
  { name: "zeta", calls: 20, success: 10, failure: 10 },
  { name: "alpha", calls: 10, success: 9, failure: 1 },
  { name: "beta", calls: 10, success: 10, failure: 0 },
  { name: "idle", calls: 0, success: 0, failure: 0 },
];
function names(view: InstanceType<typeof ToolStatsPaneView>): string[] {
  return Array.from(view.root.querySelectorAll(".tool-stats-tool-name"), el => el.textContent!);
}
function sort(view: InstanceType<typeof ToolStatsPaneView>, key: string): HTMLButtonElement {
  const button = view.root.querySelector<HTMLButtonElement>(`th[data-sort-key="${key}"] button`)!;
  button.click();
  return button;
}

test("scope is initialized and compact summary contains no duplicate success count", () => {
  const view = new ToolStatsPaneView();
  assert.equal(view.filterGlobalButton.getAttribute("aria-pressed"), "true");
  assert.equal(view.filterSessionButton.getAttribute("aria-pressed"), "false");
  view.setTools(rows, "alpha");
  assert.equal(view.root.querySelectorAll(".tool-stats-overview-stat").length, 3);
  assert.ok(view.root.querySelector(".tool-stats-toolbar .tool-stats-overview"));
  assert.equal(view.root.querySelectorAll(".tool-stats-table-tools th").length, 4);
  let scope = "";
  view.onFilterChange(value => { scope = value; });
  view.filterSessionButton.click();
  assert.equal(scope, "session");
  assert.equal(view.filterSessionButton.getAttribute("aria-pressed"), "true");
  view.setRecordingDisabled(true);
  assert.equal(view.root.querySelector<HTMLElement>(".tool-stats-notice")!.hidden, false);
  view.setRecordingDisabled(false);
  assert.equal(view.root.querySelector<HTMLElement>(".tool-stats-notice")!.hidden, true);
});

test("all four headers sort in both directions with numeric counts, ratios and stable name ties", () => {
  const view = new ToolStatsPaneView();
  view.setTools(rows, "alpha");
  assert.deepEqual(names(view), ["zeta", "alpha", "beta", "idle"]);
  for (const [key, firstOrder, secondOrder] of [
    ["name", ["alpha", "beta", "idle", "zeta"], ["zeta", "idle", "beta", "alpha"]],
    ["failure", ["zeta", "alpha", "beta", "idle"], ["beta", "idle", "alpha", "zeta"]],
    ["rate", ["beta", "alpha", "zeta", "idle"], ["idle", "zeta", "alpha", "beta"]],
    ["calls", ["zeta", "alpha", "beta", "idle"], ["idle", "alpha", "beta", "zeta"]],
  ] as const) {
    sort(view, key);
    assert.deepEqual(names(view), firstOrder);
    sort(view, key);
    assert.deepEqual(names(view), secondOrder);
  }
  assert.deepEqual(rows.map(row => row.name), ["zeta", "alpha", "beta", "idle"]);
  view.setTools([...rows].reverse(), "alpha");
  assert.deepEqual(names(view), ["idle", "alpha", "beta", "zeta"]);
});

test("rate ordering uses unrounded ratios and safely includes zero calls", () => {
  const view = new ToolStatsPaneView();
  view.setTools([
    { name: "alpha", calls: 1000, success: 951, failure: 49 },
    { name: "zeta", calls: 1000, success: 954, failure: 46 },
    { name: "idle", calls: 0, success: 0, failure: 0 },
  ], "alpha");
  sort(view, "rate");
  assert.deepEqual(names(view), ["zeta", "alpha", "idle"]);
});

test("rightmost native disclosure preserves history and selection during sorting", () => {
  const view = new ToolStatsPaneView();
  view.setTools(rows, "alpha");
  view.setInvocations("alpha", [
    { id: "bad", name: "alpha", status: "exception", reason: "failed", sessionId: "session-a", startedAt: 1000, durationMs: 125, sceneJson: '{"message":"<script>unsafe</script>"}' },
    { id: "ok", name: "alpha", status: "success", reason: "completed", sessionId: "session-a", startedAt: 2000, durationMs: 25 },
    { id: "denied", name: "alpha", status: "denied", reason: "permission_denied", sessionId: "session-b", startedAt: 3000, durationMs: 0 },
  ]);
  const records = view.root.querySelectorAll<HTMLTableRowElement>(".tool-stats-invocation-row");
  assert.equal(records.length, 3);
  assert.ok(Array.from(records).every(row => row.querySelectorAll("td").length === 6));
  assert.equal(records[1]!.querySelector("button"), null);
  const button = records[0]!.querySelector<HTMLButtonElement>("td:last-child button")!;
  const scene = view.root.querySelector<HTMLTableRowElement>(`#${button.getAttribute("aria-controls")}`)!;
  assert.equal(scene.querySelector("td")!.colSpan, 6);
  assert.equal(scene.hidden, true);
  button.click();
  assert.equal(scene.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(scene.querySelector("script"), null);
  const headerButton = sort(view, "name");
  assert.equal(view.root.querySelector("th[data-sort-key='name'] button"), headerButton);
  assert.equal(view.getSelectedName(), "alpha");
  assert.equal(scene.hidden, false);
  assert.equal(view.root.querySelector(".tool-stats-expand-button"), button);
  button.click();
  assert.equal(scene.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  const selected = view.root.querySelector<HTMLElement>('[data-tool-name="beta"]')!;
  let selection = "";
  view.onToolSelect(name => { selection = name; });
  selected.click();
  assert.equal(selection, "beta");
  assert.equal(selected.getAttribute("aria-pressed"), "true");
  assert.equal(view.root.querySelector('[data-tool-name="alpha"]')!.getAttribute("aria-pressed"), "false");
});

test("scene controls have unique IDs across views and empty states remain usable", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const view = new ToolStatsPaneView();
    view.setInvocations("alpha", [{ id: "same", name: "alpha", status: "tool_error", reason: "failed", sessionId: "s", startedAt: 1, durationMs: 1 }]);
    const id = view.root.querySelector(".tool-stats-expand-button")!.getAttribute("aria-controls")!;
    assert.ok(!ids.has(id));
    ids.add(id);
    view.setTools([], "", "Open a conversation.");
    assert.ok(view.root.textContent!.includes("Open a conversation."));
    view.setInvocations("", []);
    assert.equal(view.root.querySelector(".tool-stats-selection"), null);
    assert.equal(
      view.root.querySelector(".tool-stats-section-invocations")!.getAttribute("aria-label"),
      "Invocations",
    );
  }
});
