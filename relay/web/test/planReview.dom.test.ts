/**
 * DOM tests: plan approval bar (PlanReviewBarView web port) + the sync
 * controller — mount gating (approvalPending × running), Detail preview
 * load/cache, optimistic dismiss + error restore, and the keep-live rule
 * that stops metadata resyncs from restarting the panel.
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

const { createPlanReviewBar, createPlanReviewSync } = await import("../src/planReview.js");

type PlanDoc = NonNullable<import("../src/planReview.js").PlanReviewTarget["planDoc"]>;
const doc = (over: Partial<PlanDoc> = {}): PlanDoc => ({
  path: "docs/plans/demo.md",
  summary: "Port the desktop review bar.",
  approvalPending: true,
  ...over,
});

function findBtn(bar: HTMLElement, label: string): HTMLButtonElement {
  const btns = Array.from(bar.querySelectorAll<HTMLButtonElement>(".plan-review-bar-btn"));
  const hit = btns.find((b) => (b.textContent ?? "").includes(label));
  if (!hit) throw new Error(`button not found: ${label}`);
  return hit;
}

test("bar builds title, summary fallback, and the three actions", () => {
  const bar = createPlanReviewBar({
    summary: "  ",
    docPath: "docs/plans/demo.md",
    onApprove: () => {},
    onDiscard: () => {},
  });
  assert.match(bar.root.querySelector(".plan-review-bar-title")!.textContent ?? "", /Plan ready for review/);
  // Blank summary falls back to the instruction line.
  assert.match(
    bar.root.querySelector(".plan-review-bar-detail-text")!.textContent ?? "",
    /Review the plan document/,
  );
  assert.equal(findBtn(bar.root, "Detail").hidden, false);
  assert.equal(findBtn(bar.root, "Discard").hidden, false);
  assert.equal(findBtn(bar.root, "Approve").hidden, false);
  assert.ok(findBtn(bar.root, "Approve").classList.contains("action-primary"));
  assert.ok(findBtn(bar.root, "Discard").classList.contains("action-danger"));
  assert.equal(findBtn(bar.root, "Detail").classList.contains("action-primary"), false);
  assert.equal(bar.isExpanded(), false);
  assert.equal(bar.root.querySelector(".plan-review-bar-error")!.hidden, true);
});

test("bar without a doc path omits Detail entirely (desktop parity)", () => {
  const bar = createPlanReviewBar({ onApprove: () => {}, onDiscard: () => {} });
  // Desktop appends Detail only when a docPath exists — not hidden, absent.
  assert.equal(bar.root.textContent?.includes("Detail"), false);
  assert.equal(bar.root.querySelectorAll(".plan-review-bar-btn").length, 2);
});

test("setBusy disables every action; setError shows and clears", () => {
  const bar = createPlanReviewBar({ docPath: "docs/plans/demo.md", onApprove: () => {}, onDiscard: () => {} });
  bar.setBusy(true);
  assert.equal(findBtn(bar.root, "Detail").disabled, true);
  assert.equal(findBtn(bar.root, "Discard").disabled, true);
  assert.equal(findBtn(bar.root, "Approve").disabled, true);
  bar.setBusy(false);
  assert.equal(findBtn(bar.root, "Approve").disabled, false);

  bar.setError("Plan document changed since review.");
  const err = bar.root.querySelector(".plan-review-bar-error")!;
  assert.equal(err.hidden, false);
  assert.match(err.textContent ?? "", /changed since review/);
  bar.setError(null);
  assert.equal(err.hidden, true);
});

test("Detail expands, loads markdown once, and caches across toggles", async () => {
  let loads = 0;
  const bar = createPlanReviewBar({
    docPath: "docs/plans/demo.md",
    onApprove: () => {},
    onDiscard: () => {},
    onLoadMarkdown: async () => {
      loads += 1;
      return "# Title\n\n- step one";
    },
  });
  const detail = findBtn(bar.root, "Detail");
  detail.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bar.isExpanded(), true);
  assert.equal(detail.getAttribute("aria-expanded"), "true");
  const body = bar.root.querySelector(".plan-review-bar-preview-body")!;
  assert.match(body.textContent ?? "", /step one/);

  detail.click(); // collapse
  assert.equal(bar.isExpanded(), false);
  detail.click(); // re-expand — cache serves, no second fetch
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads, 1);
});

test("Detail load failure surfaces the could-not-load line", async () => {
  const bar = createPlanReviewBar({
    docPath: "docs/plans/demo.md",
    onApprove: () => {},
    onDiscard: () => {},
    onLoadMarkdown: async () => null,
  });
  findBtn(bar.root, "Detail").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(
    bar.root.querySelector(".plan-review-bar-preview-body")!.textContent ?? "",
    /Could not load plan document/,
  );
});

// ── sync controller ─────────────────────────────────────────

function mountSync(over: {
  runAction?: import("../src/planReview.js").PlanReviewDeps["runAction"];
  loadMarkdown?: import("../src/planReview.js").PlanReviewDeps["loadMarkdown"];
} = {}) {
  const calls: string[] = [];
  const loads: string[] = [];
  const sync = createPlanReviewSync({
    runAction: over.runAction ?? (async () => ({ ok: true })),
    loadMarkdown:
      over.loadMarkdown ?? (async (path) => {
        loads.push(path);
        return "# cached doc";
      }),
    onAfterAction: () => calls.push("after"),
  });
  document.body.append(sync.host);
  return { sync, calls, loads };
}

const session = (planDoc: PlanDoc | null, status = "idle") => ({ status, planDoc });

test("inactive sessions keep the host hidden", () => {
  const { sync } = mountSync();
  sync.sync(session(null));
  sync.sync(session(doc({ approvalPending: false })));
  sync.sync(session(doc(), "running"));
  assert.equal(sync.host.hidden, true);
  assert.equal(sync.host.childNodes.length, 0);
});

test("approvalPending + idle mounts the open host with the bar", () => {
  const { sync } = mountSync();
  sync.sync(session(doc()));
  assert.equal(sync.host.hidden, false);
  assert.equal(sync.host.classList.contains("is-open"), true);
  assert.equal(sync.host.querySelectorAll(".plan-review-bar").length, 1);
  assert.match(
    sync.host.querySelector(".plan-review-bar-detail-text")!.textContent ?? "",
    /Port the desktop review bar/,
  );
});

test("resync with unchanged content keeps the live node (no restart)", () => {
  const { sync } = mountSync();
  sync.sync(session(doc()));
  const barNode = sync.host.querySelector(".plan-review-bar")!;
  sync.sync(session(doc()));
  assert.equal(sync.host.querySelector(".plan-review-bar"), barNode);
});

test("doc path change rebuilds and drops the markdown cache", async () => {
  const { sync, loads } = mountSync();
  sync.sync(session(doc({ path: "docs/plans/a.md" })));
  const detail = findBtn(sync.host.querySelector(".plan-review-bar") as HTMLElement, "Detail");
  detail.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(loads, ["docs/plans/a.md"]);

  sync.sync(session(doc({ path: "docs/plans/b.md" })));
  const barNode = sync.host.querySelector(".plan-review-bar") as HTMLElement;
  // Rebuilt bar restores the expanded state and reloads the new doc.
  assert.equal(barNode.classList.contains("is-expanded"), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(loads, ["docs/plans/a.md", "docs/plans/b.md"]);
});

test("running session dismisses the mounted bar", async () => {
  const { sync } = mountSync();
  sync.sync(session(doc()));
  assert.equal(sync.host.hidden, false);
  sync.sync(session(doc(), "running"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sync.host.hidden, true);
});

test("approve: optimistic dismiss → action → after-hook on success", async () => {
  const acted: string[] = [];
  const { sync, calls } = mountSync({
    runAction: async (action) => {
      acted.push(action);
      return { ok: true };
    },
  });
  sync.sync(session(doc()));
  findBtn(sync.host.querySelector(".plan-review-bar") as HTMLElement, "Approve").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(acted, ["approvePlan"]);
  assert.deepEqual(calls, ["after"]);
  assert.equal(sync.host.hidden, true);
});

test("approve bounced: bar returns with the device error text", async () => {
  const { sync } = mountSync({
    runAction: async () => ({ ok: false, error: "Plan document changed since review." }),
  });
  sync.sync(session(doc()));
  findBtn(sync.host.querySelector(".plan-review-bar") as HTMLElement, "Approve").click();
  await new Promise((r) => setTimeout(r, 0));
  // onAfterAction hands the session back to the host → resync re-mounts
  // carrying the error.
  sync.sync(session(doc()));
  const barNode = sync.host.querySelector(".plan-review-bar") as HTMLElement;
  const err = barNode.querySelector(".plan-review-bar-error")! as HTMLElement;
  assert.equal(err.hidden, false);
  assert.match(err.textContent ?? "", /changed since review/);
});

test("approve threw: bar returns with the thrown message", async () => {
  const { sync } = mountSync({
    runAction: async () => {
      throw new Error("device offline");
    },
  });
  sync.sync(session(doc()));
  findBtn(sync.host.querySelector(".plan-review-bar") as HTMLElement, "Discard").click();
  await new Promise((r) => setTimeout(r, 0));
  sync.sync(session(doc()));
  const err = (sync.host.querySelector(".plan-review-bar") as HTMLElement)
    .querySelector(".plan-review-bar-error")! as HTMLElement;
  assert.equal(err.hidden, false);
  assert.match(err.textContent ?? "", /device offline/);
});

test("a resync during an in-flight action never resurrects the bar", async () => {
  let release: (() => void) | null = null;
  const { sync } = mountSync({
    runAction: () =>
      new Promise<{ ok: boolean }>((resolve) => {
        release = () => resolve({ ok: true });
      }),
  });
  sync.sync(session(doc()));
  findBtn(sync.host.querySelector(".plan-review-bar") as HTMLElement, "Approve").click();
  // plan_approval / status events fire loadSession mid-flight…
  sync.sync(session(doc()));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sync.host.hidden, true);
  release!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sync.host.hidden, true);
});

test("expanded preview survives an unchanged-content rebuild", async () => {
  const { sync } = mountSync();
  sync.sync(session(doc()));
  findBtn(sync.host.querySelector(".plan-review-bar") as HTMLElement, "Detail").click();
  await new Promise((r) => setTimeout(r, 0));
  sync.sync(session(doc()));
  const barNode = sync.host.querySelector(".plan-review-bar") as HTMLElement;
  assert.equal(barNode.classList.contains("is-expanded"), true);
  assert.match(
    barNode.querySelector(".plan-review-bar-preview-body")!.textContent ?? "",
    /cached doc/,
  );
});
