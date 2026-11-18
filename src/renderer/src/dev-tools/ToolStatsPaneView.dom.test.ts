import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { join } from "node:path";
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
  assert.ok(Array.from(records).every(row => row.querySelectorAll("td").length === 7));
  assert.equal(records[1]!.querySelector("button"), null);
  const button = records[0]!.querySelector<HTMLButtonElement>("td:last-child button")!;
  const scene = view.root.querySelector<HTMLTableRowElement>(`#${button.getAttribute("aria-controls")}`)!;
  assert.equal(scene.querySelector("td")!.colSpan, 7);
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

test("invocation timestamps carry the date, not just the wall clock", () => {
  const view = new ToolStatsPaneView();
  const startedAt = new Date(2026, 4, 6, 7, 8, 9).getTime();
  view.setInvocations("alpha", [
    { id: "when", name: "alpha", status: "success", reason: "completed", sessionId: "s", startedAt, durationMs: 5 },
  ]);
  const cell = view.root.querySelector<HTMLTableCellElement>(".tool-stats-invocation-row .is-time")!;
  assert.equal(cell.textContent, "05-06 07:08:09");
  assert.equal(cell.title, new Date(startedAt).toLocaleString());
});

test("each invocation shows the tool-description revision it ran under", () => {
  const view = new ToolStatsPaneView();
  view.setInvocations("alpha", [
    { id: "base", name: "alpha", status: "success", reason: "ok", sessionId: "s", startedAt: 1, durationMs: 1 },
    { id: "bumped", name: "alpha", status: "success", reason: "ok", sessionId: "s", startedAt: 2, durationMs: 1, docRevision: 3 },
  ]);
  const revs = Array.from(
    view.root.querySelectorAll<HTMLTableCellElement>(".tool-stats-invocation-row .is-rev"),
    cell => cell.textContent,
  );
  assert.deepEqual(revs, ["r0", "r3"], "absent revision reads as the r0 baseline");
  assert.equal(
    view.root.querySelectorAll(".tool-stats-table-invocations thead th")[2]!.textContent,
    "Rev",
  );
});

function stubChartGeometry(width = 480, height = 240): () => void {
  const proto = Object.getPrototypeOf(document.createElement("div")) as
    Record<string, unknown>;
  const saved = {
    clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
  };
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => height });
  return () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete proto[key];
    }
  };
}

test("chart mode plots every recorded day and keeps quiet days as gaps", () => {
  const restore = stubChartGeometry();
  try {
    const view = new ToolStatsPaneView();
    view.setInvocations(
      "alpha",
      [{ id: "one", name: "alpha", status: "success", reason: "completed", sessionId: "s", startedAt: Date.UTC(2026, 4, 23, 1), durationMs: 5 }],
      [
        { day: "2026-05-20", calls: 4, success: 3, failure: 1 },
        { day: "2026-05-23", calls: 2, success: 2, failure: 0 },
      ],
    );
    const modes: string[] = [];
    view.onViewModeChange(mode => modes.push(mode));
    view.chartViewButton.click();

    assert.equal(view.getViewMode(), "chart");
    assert.deepEqual(modes, ["chart"]);
    assert.equal(view.chartViewButton.getAttribute("aria-pressed"), "true");
    assert.equal(view.listViewButton.getAttribute("aria-pressed"), "false");
    assert.ok(view.root.querySelector(".tool-stats-chart svg"));
    assert.equal(
      view.root.querySelector(".tool-stats-section-meta")!.textContent,
      "alpha · 6 calls · 83%",
    );
    assert.equal(
      view.root.querySelectorAll(".series-line").length,
      2,
      "one stroke run per contiguous stretch of call-days",
    );
    assert.equal(view.root.querySelectorAll(".series-dot").length, 2);
    assert.equal(view.root.querySelectorAll(".zero-mark").length, 2);
    assert.equal(
      view.root.querySelectorAll(".day-label").length,
      4,
      "all four days are labelled at this width — 05-20 … 05-23",
    );
    assert.ok(view.root.querySelectorAll(".axis-label").length >= 3);

    view.listViewButton.click();
    assert.equal(view.getViewMode(), "list");
    assert.ok(view.root.querySelector(".tool-stats-table-invocations"));
    assert.equal(view.root.querySelector(".tool-stats-chart"), null);
  } finally {
    restore();
  }
});

test("chart mode draws one curve per tool-description revision, with a legend", () => {
  const restore = stubChartGeometry();
  try {
    const view = new ToolStatsPaneView();
    view.setInvocations("alpha", [], [
      { day: "2026-05-20", revision: 0, calls: 4, success: 2, failure: 2 },
      { day: "2026-05-21", revision: 0, calls: 2, success: 2, failure: 0 },
      { day: "2026-05-21", revision: 1, calls: 5, success: 5, failure: 0 },
      { day: "2026-05-22", revision: 1, calls: 4, success: 1, failure: 3 },
    ]);
    view.setViewMode("chart");

    assert.equal(view.root.querySelectorAll(".series-line.s1").length, 1);
    assert.equal(view.root.querySelectorAll(".series-line.s2").length, 1);
    assert.equal(view.root.querySelectorAll(".series-area").length, 0, "no overlapping washes");
    assert.equal(
      view.root.querySelector(".tool-stats-section-meta")!.textContent,
      "alpha · 15 calls · 67%",
      "header meta sums every revision",
    );
    const legend = view.root.querySelector<HTMLElement>(".tool-stats-legend")!;
    assert.equal(legend.hidden, false);
    assert.deepEqual(
      Array.from(legend.querySelectorAll(".tool-stats-legend-chip"), chip => chip.textContent),
      ["r0", "r1"],
    );
    assert.ok(legend.querySelector(".tool-stats-legend-chip.s2"), "second curve gets palette slot 2");

    view.setInvocations("alpha", [], [
      { day: "2026-05-20", revision: 0, calls: 4, success: 4, failure: 0 },
    ]);
    assert.equal(view.root.querySelector<HTMLElement>(".tool-stats-legend")!.hidden, true);
    assert.equal(view.root.querySelectorAll(".series-area").length, 1);
    assert.equal(view.root.querySelectorAll(".series-line.s1").length, 1);
    view.destroy();
    view.root.remove();
  } finally {
    restore();
  }
});

test("hover readout escapes the chart box into the top layer", () => {
  const restore = stubChartGeometry();
  try {
    const view = new ToolStatsPaneView();
    document.body.append(view.root);
    view.setInvocations(
      "alpha",
      [],
      [
        { day: "2026-05-20", calls: 4, success: 3, failure: 1 },
        { day: "2026-05-23", calls: 2, success: 2, failure: 0 },
      ],
    );
    view.setViewMode("chart");
    assert.equal(view.root.querySelector(".tool-stats-chart-tip"), null);
    const tip = document.querySelector<HTMLElement>(".tool-stats-chart-tip")!;
    assert.ok(tip, "tip is mounted outside the pane");
    assert.equal(tip.getAttribute("popover"), "manual");
    assert.equal(tip.getAttribute("role"), "tooltip");

    view.setViewMode("list");
    assert.equal(document.querySelector(".tool-stats-chart-tip"), null);
    view.root.remove();
  } finally {
    restore();
  }
});

test("title row and tools header share one band height token", () => {
  const css = readFileSync(join(import.meta.dirname, "tool-stats.css"), "utf8");
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `missing rule: ${selector}`);
    return css.slice(start, css.indexOf("}", start) + 1);
  };
  assert.match(block(".tool-stats-pane"), /--tool-stats-head-row: 27px/);
  assert.match(block(".tool-stats-table thead th"), /height: var\(--tool-stats-head-row\)/);
  assert.match(block(".tool-stats-section-head"), /height: var\(--tool-stats-head-row\)/);
  assert.match(block(".tool-stats-chart-tip"), /position: fixed/);
  assert.match(block(".tool-stats-chart-tip"), /inset: auto/);
});

test("chart mode surfaces its own empty states", () => {
  const restore = stubChartGeometry();
  try {
    const view = new ToolStatsPaneView();
    view.setViewMode("chart");
    assert.ok(view.root.textContent!.includes("Select a tool on the left."));
    view.setInvocations("alpha", []);
    assert.ok(view.root.textContent!.includes("No invocations in this range."));
    assert.equal(view.root.querySelector(".tool-stats-section-meta")!.textContent, "alpha · 0 calls · —");
  } finally {
    restore();
  }
});

test("title row height and toggle styling stay locked to the tools header", () => {
  const css = readFileSync(join(import.meta.dirname, "tool-stats.css"), "utf8");
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `missing rule: ${selector}`);
    return css.slice(start, css.indexOf("}", start) + 1);
  };
  assert.match(block(".tool-stats-section-head"), /height: var\(--tool-stats-head-row\)/);
  assert.match(block(".tool-stats-table thead th"), /height: var\(--tool-stats-head-row\)/);
  assert.match(block(".tool-stats-section-head"), /border-bottom: 1px solid var\(--tool-stats-line\)/);
  assert.match(block(".tool-stats-chart"), /height: 100%/);
  assert.ok(
    css.includes(':root[data-theme="light"] .tool-stats-view-toggle button.is-active'),
  );
  assert.match(
    css.slice(css.indexOf(':root[data-theme="light"] .tool-stats-view-toggle')),
    /background: var\(--accent\)/,
  );
});

test("revision palette is declared on :root for both themes and reaches every curve element", () => {
  const css = readFileSync(join(import.meta.dirname, "tool-stats.css"), "utf8");
  assert.match(css, /:root \{\s*--tool-stats-series-1: var\(--accent\)/);
  const light = css.slice(css.indexOf(':root[data-theme="light"]'));
  assert.match(light.slice(0, light.indexOf("}")), /--tool-stats-series-2: #b45309/);
  for (const bucket of [2, 3, 4, 5, 6]) {
    assert.ok(
      css.includes(`.series-line.s${bucket} { stroke: var(--tool-stats-series-${bucket}); }`),
      `missing line ink for s${bucket}`,
    );
    assert.ok(css.includes(`.series-dot.s${bucket}`), `missing dot ink for s${bucket}`);
    assert.ok(css.includes(`.hover-dot.s${bucket}`), `missing hover dot ink for s${bucket}`);
  }
  assert.ok(
    css.includes(".tool-stats-chart-tip-row.s2::before"),
    "multi-revision readout keeps a coloured swatch in the top-layer tip",
  );
});

test("scene controls have unique IDs across views and empty states remain usable", () => {  const ids = new Set<string>();
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
