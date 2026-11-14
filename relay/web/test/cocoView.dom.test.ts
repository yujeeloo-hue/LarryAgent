/**
 * DOM test: CocoView (relay web CoCo workspace).
 *
 * Asserts the demo-parity contract: three-column workspace with the chat
 * panel as the third column, client-parity budget bars (gradient fill
 * widths + compact counts), transcript bubbles, zebra queue with icon-only
 * actions, inline question/approval cards, rules page actions (Create/Edit
 * toast — device-side per decision #8), readonly gating, loading/error
 * states, and composer text/focus surviving snapshot re-renders.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
}));

const { CocoController } = await import("../src/CocoController.js");
const { CocoView } = await import("../src/CocoView.js");
const { cocoIconMarkup } = await import("../src/cocoIcons.js");

type Call = { deviceId: string; action: string; payload?: unknown };

const WORK = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, goalId: "g1", title: `Work ${id}`, objective: "Do the thing.", workspaceId: "w1",
  status, priority: 5, dependsOn: [], steps: [], acceptance: [], deliverables: [], ruleIds: [],
  revision: 1, repairs: 0, createdAt: 1, updatedAt: 2, summary: "", timeline: [], ...over,
});

function snapshot(over: Record<string, unknown> = {}) {
  return {
    state: "working",
    settings: {
      enabled: true, providerId: "p", hourlyTokens: 12000, dailyTokens: 60000,
      timezone: "Asia/Shanghai", excludedWorkspaceIds: [], fullPermissions: false,
      heartbeatMinutes: 30, repairLimit: 2, reportTime: "18:00", historyRetentionDays: 30,
    },
    budget: { hourly: 4100, daily: 23000, estimated: false },
    work: [WORK("w-run", "executing"), WORK("w-decide", "to_decide")],
    rules: [{
      id: "r1", name: "Work progress inspection", objective: "Inspect progress.",
      mode: "inspection", scope: { all: true, workspaceIds: [], excludedWorkspaceIds: [] },
      enabled: true, confirmed: true, cadence: { kind: "minute", n: 15 },
      origin: "coco", fullPermissions: true, providerId: "p", acceptance: [],
      nextRunAt: Date.now() + 3_600_000, createdAt: 1,
    }],
    messages: [
      { id: "m1", role: "user", text: "Plan this week.", at: 1 },
      { id: "m2", role: "assistant", text: "Here is the plan.\n\nStep two follows.", at: 2 },
    ],
    reports: [{ id: "rep1", at: Date.now(), title: "Daily work report", markdown: "", workIds: [] }],
    workspaces: [{ id: "w1", name: "JellyBot" }],
    chat: {
      sessionId: "chat-1",
      status: "running",
      question: {
        requestId: "q-1", sessionId: "chat-1", toolCallId: "t1",
        question: "Which cadence?", options: ["Daily at 18:00", "Mondays 09:00"],
        allowCustom: true, allowMultiple: false,
      },
    },
    backgroundTasks: [],
    ...over,
  };
}

function queueItem(id: string, userText: string) {
  return { id, sessionId: "chat-1", userText, attachments: [], createdAt: 1, mode: "deferred" };
}

function makeView(opts: {
  snap?: () => unknown;
  queue?: () => unknown[];
  readonly?: boolean;
  headBadge?: () => HTMLElement;
} = {}) {
  const calls: Call[] = [];
  const request = async <T,>(deviceId: string, action: string, payload?: unknown): Promise<T> => {
    calls.push({ deviceId, action, payload });
    if (action === "cocoSnapshot") return (opts.snap ?? (() => snapshot()))() as T;
    if (action === "listPromptQueue") return (opts.queue ?? (() => [queueItem("q1", "queued msg")]))() as T;
    return { accepted: true } as T;
  };
  const controller = new CocoController({ deviceId: "dev-1", request });
  const toasts: string[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  const view = new CocoView(root, controller, {
    device: { name: "JOJI's MacBook Pro", platform: "darwin" },
    readonly: opts.readonly ?? false,
    onExit: () => {},
    onToast: (m) => toasts.push(m),
    ...(opts.headBadge ? { headBadge: opts.headBadge } : {}),
  });
  return { calls, controller, view, root, toasts, request, async ready() { await controller.refresh(); } };
}

const $$ = (root: ParentNode, sel: string) => root.querySelectorAll(sel);
const $ = (root: ParentNode, sel: string) => root.querySelector(sel);

test("ready: three-column workspace, banner, budget bars, chat panel", async () => {
  const v = makeView();
  await v.ready();
  const ws = $(v.root, ".coco-workspace");
  assert.ok(ws, "workspace renders");
  assert.ok(ws?.classList.contains("is-chat-open"), "chat column present");
  // nav: Chat toggle + Work group (Overview, To decide, Reports) + Automation (Rules)
  const navLabels = [...$$(v.root, ".coco-nav-item")].map((n) => n.textContent?.trim());
  assert.deepEqual(navLabels, ["Chat", "Overview", "To decide", "Reports", "Rules"]);
  assert.equal($(v.root, ".coco-nav-item")?.getAttribute("aria-expanded"), "true");
  // runtime banner: 32px CoCo logo + state label
  assert.equal($(v.root, ".coco-runtime-heading .ico")?.querySelector("svg") != null, true);
  assert.equal($(v.root, ".coco-runtime strong")?.textContent, "Working");
  assert.equal($(v.root, ".view-head .count-pill")?.textContent, "Working");
  // budget rows: client-parity fill widths + compact token counts
  const rows = [...$$(v.root, ".coco-budget-row")];
  assert.equal(rows.length, 2);
  const [hourly, daily] = rows;
  // linkedom serializes inline style without the colon space — normalize.
  const width = (row: Element | undefined): string =>
    (row?.querySelector(".coco-budget-bar i")?.getAttribute("style") ?? "").replace(/\s+/g, "");
  assert.equal(width(hourly), "width:34.2%");
  assert.equal(width(daily), "width:38.3%");
  assert.equal(hourly?.querySelector(".coco-budget-detail")?.textContent, "4.1k / 12k tokens");
  assert.equal(daily?.querySelector(".coco-budget-detail")?.textContent, "23k / 60k tokens");
  // overview lists executing + to-decide work
  assert.ok($(v.root, ".coco-flow-head")?.textContent?.includes("Moving forward"));
  assert.ok([...$$(v.root, ".coco-section h3")].some((h) => h.textContent === "To decide"));
  // latest report card
  assert.ok($(v.root, ".coco-latest-report"), "latest report card renders");
  // chat panel third column
  assert.ok($(v.root, ".coco-chat"), "chat panel renders");
});

test("chat: transcript bubbles, question card, zebra queue, composer", async () => {
  const v = makeView();
  await v.ready();
  const user = $(v.root, ".conversation-msg-user .conversation-msg-body");
  assert.equal(user?.textContent, "Plan this week.");
  const paras = [...$$(v.root, ".conversation-msg-assistant .conversation-msg-body p")];
  assert.equal(paras.length, 2, "assistant prose splits paragraphs");
  // question card options wire to chatControl answer
  const card = $(v.root, ".coco-chat-prompt");
  assert.ok(card?.textContent?.includes("Which cadence?"));
  const option = [...(card?.querySelectorAll("button") ?? [])]
    .find((b) => b.textContent === "Daily at 18:00");
  option?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const answerCall = v.calls.find((c) => c.action === "cocoCommand");
  assert.deepEqual(answerCall?.payload, {
    command: { type: "chatControl", action: "answer", requestId: "q-1", selected: "Daily at 18:00", custom: false },
  });
  // queue: one zebra row with promote + remove icon-only actions
  const qRow = $(v.root, ".coco-queue-row");
  assert.ok(qRow?.textContent?.includes("queued msg"));
  const actions = [...(qRow?.querySelectorAll(".coco-queue-action") ?? [])];
  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.getAttribute("aria-label"), "Interrupt and send");
  // composer present with the client placeholder; the send control wears the
  // stop face (Square) while a turn runs — never disabled mid-run.
  assert.ok($(v.root, ".coco-composer"));
  assert.match($(v.root, ".coco-composer")?.getAttribute("placeholder") ?? "", /Give CoCo a goal/);
  const sendBtn = $(v.root, ".composer-send-btn") as HTMLButtonElement | null;
  assert.ok(sendBtn?.classList.contains("is-stop"), "stop face while working");
  assert.equal(sendBtn?.hasAttribute("disabled"), false);
  assert.ok(sendBtn?.querySelector("svg"), "face icon mounted as a node");
  assert.ok($(v.root, ".context-usage-ring"), "context ring renders");
});

test("queue promote/remove hit the prompt-queue actions", async () => {
  const v = makeView();
  await v.ready();
  $(v.root, ".coco-queue-action.is-insert")?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(v.calls.some((c) => c.action === "promoteQueuedPrompt"), true);
  const removeBtn = [...$$(v.root, ".coco-queue-row")].at(-1)?.querySelectorAll(".coco-queue-action")[1];
  removeBtn?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(v.calls.some((c) => c.action === "removeQueuedPrompt"), true);
});

test("toggle chat closed drops the third column", async () => {
  const v = makeView();
  await v.ready();
  v.controller.toggleChat(false);
  assert.ok(!$(v.root, ".coco-chat"), "panel gone");
  assert.ok(!$(v.root, ".coco-workspace")?.classList.contains("is-chat-open"));
  v.controller.toggleChat(true);
  assert.ok($(v.root, ".coco-chat"));
});

test("to-decide page → work detail decision card answers via work.resume", async () => {
  const v = makeView({ snap: () => snapshot({
    work: [WORK("w-decide", "to_decide", {
      decisionPrompt: { question: "Which cadence?", options: ["Mondays 09:00", "Daily 18:00"], allowCustom: true },
    })],
  }) });
  await v.ready();
  v.controller.setPage("to-decide");
  assert.ok($(v.root, ".coco-main h1")?.textContent === "To decide");
  assert.ok([...$$(v.root, ".coco-section h3")].some((h) => h.textContent === "Waiting for your decision"));
  // open the work detail
  $(v.root, ".coco-work-row")?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok($(v.root, ".coco-main h1")?.textContent?.startsWith("Work w-decide"));
  assert.ok([...$$(v.root, ".coco-section h3")].some((h) => h.textContent === "Your decision"));
  const choice = [...$$(v.root, ".coco-section .coco-actions .coco-button")]
    .find((b) => b.textContent === "Mondays 09:00");
  choice?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const cmd = v.calls.find((c) => c.action === "cocoCommand");
  assert.deepEqual(cmd?.payload, {
    command: { type: "work", id: "w-decide", action: "resume", answer: "Mondays 09:00" },
  });
});

test("rules page: unsupported actions hidden; Pause/Run now/Delete wired (decision #8)", async () => {
  const v = makeView();
  await v.ready();
  v.controller.setPage("rules");
  // Decision #8: the editor lives on the device — Create/Edit never render.
  const labels = [...$$(v.root, ".coco-rule-card .coco-button")].map((b) => b.textContent);
  assert.equal(labels.includes("Edit"), false, "Edit hidden");
  assert.equal(labels.includes("Create rule"), false, "Create hidden");
  assert.deepEqual(labels, ["Pause", "Run now", "Delete"]);
  // toggle + run send rule commands
  const pause = [...$$(v.root, ".coco-rule-card .coco-button")].find((b) => b.textContent === "Pause");
  pause?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    v.calls.find((c) => c.action === "cocoCommand")?.payload,
    { command: { type: "rule", action: "toggle", id: "r1" } },
  );
});

test("rules delete confirms first, then sends rule.delete", async () => {
  const v = makeView();
  const confirms: unknown[] = [];
  (window as unknown as { confirm: unknown }).confirm = (msg: unknown) => { confirms.push(msg); return true; };
  await v.ready();
  v.controller.setPage("rules");
  const del = [...$$(v.root, ".coco-rule-card .coco-button.action-danger")][0];
  del?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(confirms.length, 1, "confirm dialog before delete");
  assert.deepEqual(
    v.calls.find((c) => c.action === "cocoCommand")?.payload,
    { command: { type: "rule", action: "delete", id: "r1" } },
  );
});

test("approval card renders Approve/Deny and wires chatControl approval", async () => {
  const v = makeView({ snap: () => snapshot({
    chat: { sessionId: "chat-1", status: "running", approval: { requestId: "ap-1", sessionId: "chat-1", toolName: "write_file", arguments: { path: "/tmp/x" }, expiresAt: Date.now() + 30_000 } },
  }) });
  await v.ready();
  const card = [...$$(v.root, ".coco-chat-prompt")].find((n) => n.textContent?.includes("write_file"));
  assert.ok(card, "approval card renders");
  const deny = [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Deny");
  deny?.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(v.calls.find((c) => c.action === "cocoCommand")?.payload, {
    command: { type: "chatControl", action: "approval", requestId: "ap-1", approved: false },
  });
});

test("readonly: composer swaps for the note and decisions disable", async () => {
  const v = makeView({ readonly: true, snap: () => snapshot() });
  await v.ready();
  assert.ok($(v.root, ".coco-readonly-note"), "readonly note replaces composer");
  assert.ok(!$(v.root, ".coco-composer"));
  const option = [...$$(v.root, ".coco-chat-prompt button")][0];
  assert.equal(option?.hasAttribute("disabled"), true, "question options disabled");
  v.controller.setPage("rules");
  const pause = [...$$(v.root, ".coco-rule-card .coco-button")].find((b) => b.textContent === "Pause");
  assert.equal(pause?.hasAttribute("disabled"), true, "rule actions disabled");
});

test("loading and error states", async () => {
  const v = makeView();
  v.view.render(); // controller still "loading"
  assert.ok($(v.root, ".coco-offline")?.textContent?.includes("Loading CoCo"));
  const failing = makeView({ snap: () => { throw new Error("device offline"); } });
  await failing.ready();
  assert.ok($(failing.root, ".coco-offline")?.textContent?.includes("Couldn't load CoCo"));
  assert.ok($(failing.root, ".ghost-btn"), "retry button present");
});

test("composer text and focus survive snapshot re-renders", async () => {
  let tick = 0;
  const v = makeView({ snap: () => snapshot({ messages: [...snapshot().messages, { id: `m${tick}`, role: "assistant", text: `msg ${tick}`, at: 3 + tick++ }] }) });
  await v.ready();
  const composer = $(v.root, ".coco-composer") as HTMLTextAreaElement | null;
  assert.ok(composer);
  composer.value = "half-typed thought";
  // linkedom focus() never moves document.activeElement — spy the calls
  // instead (the view restores focus on the fresh node).
  const focusLog: HTMLElement[] = [];
  const proto = (window as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
  const originalFocus = proto.focus;
  proto.focus = function (this: HTMLElement) { focusLog.push(this); } as () => void;
  // The view decides "was focused?" via document.activeElement — linkedom
  // never moves it, so stub the getter to the old composer and watch the
  // restore through the focus spy.
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composer });
  await v.controller.refresh(); // snapshot changed → full re-render
  proto.focus = originalFocus;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => dom.document.body });
  const after = $(v.root, ".coco-composer") as HTMLTextAreaElement | null;
  assert.equal(after?.value, "half-typed thought", "draft preserved");
  assert.ok(focusLog.includes(after as HTMLElement),
    `focus restored on the fresh composer (log=${focusLog.length}, after-class=${after?.className})`);
  assert.ok($(v.root, ".coco-messages")?.textContent?.includes("msg 1"), "new message rendered");
});


test("recent runs: client-parity timeline (day groups, rail, statuses, detail)", async () => {
  const now = Date.now();
  const v = makeView({ snap: () => snapshot({
    state: "idle",
    chat: { sessionId: "chat-1", status: "idle" },
    ruleRuns: [
      { id: "run-live", source: "rule", ruleId: "r1", ruleName: "Work progress inspection", startedAt: now - 60_000, status: "running", attempts: 1 },
      { id: "run-done", source: "rule", ruleId: "r1", ruleName: "Work progress inspection", startedAt: now - 3600_000, endedAt: now - 3500_000, status: "planned", attempts: 1, summary: "## Daily wrap\nPlanned two follow-up tasks." },
      { id: "run-fail", source: "chat", ruleId: "r1", ruleName: "Relay console polish", startedAt: now - 7200_000, endedAt: now - 7100_000, status: "failed", attempts: 3, error: "tool timeout" },
    ],
  }) });
  await v.ready();
  const runs = $(v.root, ".coco-runs");
  assert.ok(runs, "runs section renders");
  assert.ok(runs?.querySelector(".coco-runs-active")?.textContent?.includes("1 in progress"));
  assert.ok(runs?.querySelector(".coco-runs-meta")?.textContent?.includes("3 runs"));
  // groups: In progress (running) + Today (planned/failed same day)
  const groups = [...$$(v.root, ".coco-runs-group")].map((g) => g.querySelector(".coco-runs-day-label")?.textContent);
  assert.deepEqual(groups, ["In progress", "Today"]);
  const running = $(v.root, ".coco-run.run-running");
  assert.ok(running?.querySelector(".coco-run-dot"));
  assert.ok(running?.querySelector(".coco-run-status")?.textContent?.includes("Running"));
  assert.ok(running?.querySelector(".coco-run-time"), "rail clock renders");
  const failed = $(v.root, ".coco-run.run-failed");
  assert.equal(failed?.querySelector(".coco-run-status")?.textContent, "Completed", "chat run completed label");
  assert.ok(failed?.querySelector(".coco-run-meta")?.textContent?.includes("3 attempts"));
  assert.ok(failed?.querySelector(".coco-run-error")?.textContent?.includes("tool timeout"), "failed detail carries the error");
  const planned = $(v.root, ".coco-run.run-planned");
  assert.ok(planned?.querySelector(".coco-run-preview")?.textContent?.includes("Planned two follow-up tasks."), "heading stripped from preview");
  assert.equal(planned?.querySelector(".coco-run-detail")?.textContent?.includes("Daily wrap"), false, "heading excluded from detail too");
});

test("background task card renders with running state and clickable context", async () => {
  const v = makeView({ snap: () => snapshot({
    backgroundTasks: [{ id: "bt1", sessionId: "s9", purpose: "work", title: "Relay console implementation", status: "running", startedAt: 1, updatedAt: 2, progress: "step 3 of 5", summary: "", workId: "w-run" }],
  }) });
  await v.ready();
  const task = $(v.root, ".coco-bg-task");
  assert.ok(task?.textContent?.includes("Relay console implementation"));
  assert.ok(task?.querySelector(".mini-spin"), "running spinner");
  task?.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok($(v.root, ".coco-reference:not([hidden])"), "click anchors the reference");
});

test("CoCo artwork preserves source shape and mask dimensions, with unique references", () => {
  for (const name of ["logo", "chat", "overview", "work", "attention", "rules", "reports"]) {
    const source = document.createElement("div");
    source.innerHTML = readFileSync(new URL(
      `../../../src/renderer/src/assets/coco/${name}.svg`, import.meta.url), "utf8");
    const actual = document.createElement("div");
    actual.innerHTML = cocoIconMarkup(name);
    const geometry = (root: HTMLElement) => [...root.querySelectorAll("mask, rect")].map(node => ({
      tag: node.tagName,
      dimensions: ["x", "y", "width", "height", "rx"].map(attr => node.getAttribute(attr)),
    }));
    assert.deepEqual(geometry(actual), geometry(source), name);
    const duplicate = document.createElement("div");
    duplicate.innerHTML = cocoIconMarkup(name);
    const ids = new Set([...actual.querySelectorAll("[id]")].map(node => node.id));
    assert.ok([...duplicate.querySelectorAll("[id]")].every(node => !ids.has(node.id)));
    for (const node of actual.querySelectorAll("[fill], [mask]")) {
      for (const attr of ["fill", "mask"]) {
        const id = node.getAttribute(attr)?.match(/^url\(#(.+)\)$/)?.[1];
        if (id) assert.ok(ids.has(id), name + " reference resolves");
      }
    }
  }
});

test("latest report opens Markdown reports in readonly mode and related work survives refresh", async () => {
  let revision = 0;
  const v = makeView({ readonly: true, snap: () => snapshot({
    budget: { hourly: revision, daily: revision },
    reports: [
      { id: "old", at: 1, title: "Older report", markdown: "Earlier.", workIds: [] },
      { id: "new", at: 2, title: "Latest report", markdown: "# Results\n\n**Verified**\n\n- First\n- Second\n\n<script>unsafe()</script>", workIds: ["w-run", "w-run", "missing"] },
    ],
  }) });
  await v.ready();
  $(v.root, ".coco-latest-report")?.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(v.controller.getPage(), "reports");
  assert.deepEqual([...$$(v.root, ".coco-report h3")].map(node => node.textContent), ["Latest report", "Older report"]);
  assert.equal($(v.root, ".coco-report-body strong")?.textContent, "Verified");
  assert.equal($$(v.root, ".coco-report-body li").length, 2);
  assert.equal($$(v.root, ".coco-report-body script").length, 0);
  assert.equal($$(v.root, ".coco-report-export").length, 2);
  assert.equal(v.toasts.length, 0);
  const details = $(v.root, ".coco-report-related") as HTMLDetailsElement;
  assert.equal(details.hasAttribute("open"), false);
  assert.equal($$(details, ".coco-work-row").length, 1);
  details.open = true;
  details.dispatchEvent(new window.Event("toggle"));
  revision++;
  await v.controller.refresh();
  assert.equal($(v.root, ".coco-report-related")?.hasAttribute("open"), true);
  $(v.root, ".coco-report-related .coco-work-row")?.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal($(v.root, ".coco-work-detail-head h1")?.textContent, "Work w-run");
  // Returning to the same page from a related work item must still render.
  const nav = [...$$(v.root, ".coco-nav-item")].find(node => node.textContent?.trim() === "Reports");
  nav?.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal($$(v.root, ".coco-report").length, 2);
  assert.equal(v.calls.some(call => call.action === "cocoCommand"), false);
});

test("latest report corner marks only unread reports (client isNewReport parity)", async () => {
  const fresh = makeView({ snap: () => snapshot({
    reports: [{ id: "rep", at: Date.now(), title: "Daily work report", markdown: "", workIds: [] }],
  }) });
  await fresh.ready();
  assert.ok($(fresh.root, ".coco-latest-report-corner"), "unread report shows the accent corner");
  assert.ok($(fresh.root, ".coco-latest-report")?.getAttribute("aria-label")?.endsWith(", unread"));

  // Opening Reports (card or nav) marks it seen; the corner goes away for good.
  $(fresh.root, ".coco-latest-report")?.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(fresh.controller.getPage(), "reports");
  const overview = [...$$(fresh.root, ".coco-nav-item")].find(node => node.textContent?.trim() === "Overview");
  overview?.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal($(fresh.root, ".coco-latest-report") != null, true, "report card still renders");
  assert.equal($(fresh.root, ".coco-latest-report-corner"), null, "seen report has no corner");
  assert.ok(fresh.controller.getReportsSeenAt() > 0);

  // The 24h window: an old report is never "new", seen or not.
  const stale = makeView({ snap: () => snapshot({
    reports: [{ id: "rep", at: Date.now() - 2 * 86400000, title: "Old report", markdown: "", workIds: [] }],
  }) });
  await stale.ready();
  assert.equal($(stale.root, ".coco-latest-report-corner"), null, "stale report is not new");

  // Seen timestamp survives a reload through localStorage.
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  try {
    const reportAt = Date.now();
    const reportSnap = () => snapshot({
      reports: [{ id: "rep", at: reportAt, title: "Daily work report", markdown: "", workIds: [] }],
    });
    const first = makeView({ snap: reportSnap });
    await first.ready();
    assert.ok($(first.root, ".coco-latest-report-corner"), "first visit shows the corner");
    first.controller.setPage("reports");
    assert.equal(store.has("coco.reportsSeenAt"), true, "seen timestamp persisted");
    const reloaded = makeView({ snap: reportSnap });
    await reloaded.ready();
    assert.equal($(reloaded.root, ".coco-latest-report-corner"), null, "reload keeps the report read");
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("CoCo view head shares the standalone desktop hairline (Devices/Manage parity)", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  // Same selector list both rules: full-width row + desktop border-bottom.
  const lists = [...css.matchAll(/#manageView \.view-head, #memoryView \.view-head, #devicesView \.view-head, #cocoView \.view-head \{([^}]*)\}/g)];
  assert.equal(lists.length, 2, "width + hairline rules both list #cocoView");
  assert.ok(lists.some((match) => /border-bottom: 1px solid var\(--border\)/.test(match[1] ?? "")), "desktop hairline declared");
  assert.match(
    css,
    /@media \(min-width: 769px\) \{\s*\n\s*#manageView \.view-head, #memoryView \.view-head, #devicesView \.view-head, #cocoView \.view-head \{\s*\n\s*border-bottom: 1px solid var\(--border\);/,
    "hairline stays inside the desktop media query (mobile keeps its inset-shadow line, no doubling)",
  );
});

test("CoCo head renders the connection badge handed in by the shell", async () => {
  const v = makeView({
    headBadge: () => {
      const wrap = document.createElement("span");
      wrap.className = "head-conn";
      wrap.append(document.createElement("i"));
      return wrap;
    },
  });
  await v.ready();
  const head = $(v.root, ".view-head");
  const badge = $(head!, ".head-conn");
  assert.ok(badge, "badge rides the page head (the app topbar is hidden on standalone pages)");
  // Right-aligned before Refresh: the spacer pushes both to the far edge.
  const kids = [...head!.children].map((node) => node.className || node.tagName.toLowerCase());
  assert.equal(kids.at(-1), "ghost-btn head-refresh", "Refresh stays last and wears the phone icon box class");
  assert.equal(kids.at(-2), "head-conn", "badge sits just before Refresh");
});

test("phone tier: nav becomes a bottom tab bar and chat a full-bleed sheet", () => {
  const css = readFileSync(new URL("../src/mobile.css", import.meta.url), "utf8");
  const start = css.indexOf("@media (max-width: 560px) {");
  assert.notEqual(start, -1, "phone block present");
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) { end = i; break; }
  }
  const phone = css.slice(start, end);

  // One column + a trailing tab row; nav sits in row 2 above the sheet.
  assert.match(phone, /grid-template-rows: minmax\(0, 1fr\) auto;/, "workspace stacks content over the tab bar");
  assert.match(phone, /\.coco-nav \{\s*\n\s*grid-area: 2 \/ 1;\s*position: relative;\s*z-index: 9;/, "tab bar keeps its own row and paints above the chat sheet");
  // Chat moves to the last tab without touching the DOM order.
  assert.match(phone, /\.coco-nav-item:first-child \{ order: 9; \}/, "Chat tab ordered last");
  // Full-bleed sheet: the floating corner button gives way to the sheet header.
  assert.match(phone, /\.coco-chat-collapse \{ display: none; \}/, "corner collapse hidden on phones");
  assert.match(phone, /\.coco-chat-sheet-head \{\s*\n\s*flex: none; display: flex;/, "sheet header owns the collapse control");
  // Chat is a page in the content row, not an inset:0 overlay: as an overlay
  // it covered the tab bar and buried the composer underneath it.
  assert.match(
    phone,
    /\.coco-chat,\s*\n\s*\.coco-workspace\.is-chat-open > \.coco-chat \{\s*\n\s*--coco-chat-inset: 14px;\s*\n\s*position: relative; grid-area: 1 \/ 1;/,
    "phone chat occupies row 1 so the tab bar keeps row 2",
  );
  assert.doesNotMatch(phone, /\.coco-chat[^{]*\{[^}]*position: absolute/, "no absolute chat overlay on phones");
  // iOS focus-zoom floor.
  assert.match(phone, /\.coco-composer \{ font-size: 16px;/, "composer stays at 16px");
  assert.match(phone, /\.coco-main \{ padding: 16px 14px/, "content padding re-anchored for phones");
});

test("overlay chat is opaque (the page underneath must not bleed through)", () => {
  const css = readFileSync(new URL("../src/mobile.css", import.meta.url), "utf8");
  const start = css.indexOf("@media (max-width: 899px) {");
  assert.notEqual(start, -1, "tablet block present");
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) { end = i; break; }
  }
  const tablet = css.slice(start, end);
  // Desktop keeps the 2.5% tint (chat is its own column); as an overlay the
  // same tint let the page show through and both surfaces read as one.
  assert.match(
    tablet,
    /\.coco-chat \{[\s\S]*?background: var\(--bg\);/,
    "overlay chat paints an opaque surface token",
  );
  assert.doesNotMatch(tablet, /\.coco-chat \{[^}]*rgba\(var\(--tint-rgb\)/, "no translucent overlay");
});

test("phone tier: chat header collapses the sheet, budget bars keep their width", async () => {
  const v = makeView();
  await v.ready();
  const sheetHead = $(v.root, ".coco-chat-sheet-head");
  assert.ok(sheetHead, "sheet header renders inside the panel");
  const close = sheetHead!.querySelector(".coco-sheet-close");
  assert.equal(close?.getAttribute("aria-label"), "Collapse chat");
  close?.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal($(v.root, ".coco-chat"), null, "sheet header collapses the panel");

  // The narrow-container budget tier is what keeps the bar from collapsing
  // to 0px on a phone (fixed 7-column floor was 266px).
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(
    css,
    /@container \(max-width: 420px\) \{\s*\n\s*\.coco-budget \{ gap: 6px; \}[\s\S]*?\.coco-budget-bar \{ grid-column: 1 \/ -1; grid-row: 2; \}/,
    "budget switches to the two-row client tier when its container is narrow",
  );
  assert.match(css, /\.coco-chat-sheet-head \{ display: none; \}/, "sheet header stays out of the desktop layout");
});

test("Chat renders Markdown lists, tables and line breaks through the Relay session pipeline", async () => {
  const v = makeView({ snap: () => snapshot({ messages: [{
    id: "markdown", role: "assistant", at: 1,
    text: "**Status**\n\n- First\n- Second\n\nLine one  \nLine two\n\n| Name | State |\n| --- | --- |\n| Build | Passed |\n\n<script>unsafe()</script>",
  }] }) });
  await v.ready();
  const body = $(v.root, ".conversation-msg-assistant .conversation-msg-body")!;
  assert.equal($$(body, "strong").length, 1);
  assert.equal($$(body, "li").length, 2);
  assert.equal($$(body, "br").length, 1);
  assert.equal($$(body, "table").length, 1);
  assert.equal($$(body, "script").length, 0);
  assert.ok(body.classList.contains("md-blocks"));
});

test("Reports navigation handles an empty snapshot", async () => {
  const v = makeView({ snap: () => snapshot({ reports: [] }) });
  await v.ready();
  v.controller.setPage("reports");
  assert.ok($(v.root, ".coco-main")?.textContent?.includes("Your consolidated daily reports will appear here."));
  assert.equal($$(v.root, ".coco-report").length, 0);
});
