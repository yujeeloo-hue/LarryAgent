/**
 * DOM test: CocoController state machine (relay web CoCo view).
 *
 * Covers the plan's decision #6 contract: snapshot loads + notifies, the
 * 3s poll runs only while started, every accepted command triggers an
 * immediate snapshot re-pull, chat sends route to cocoCommand (idle) vs
 * enqueuePrompt (working), and queue ops hit the existing prompt-queue
 * actions on snapshot.chat.sessionId — never CoCo-specific ones.
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

const { CocoController, COCO_POLL_MS } = await import("../src/CocoController.js");

type Call = { deviceId: string; action: string; payload?: unknown };

function snapshot(over: Record<string, unknown> = {}) {
  return {
    state: "idle",
    settings: {
      enabled: true, providerId: "p", hourlyTokens: 12000, dailyTokens: 60000,
      timezone: "Asia/Shanghai", excludedWorkspaceIds: [], fullPermissions: false,
      heartbeatMinutes: 30, repairLimit: 2, reportTime: "18:00", historyRetentionDays: 30,
    },
    budget: { hourly: 4100, daily: 23000, estimated: false },
    work: [], rules: [], messages: [], reports: [],
    workspaces: [{ id: "w1", name: "JellyBot" }],
    chat: { sessionId: "chat-1", status: "idle" },
    ...over,
  };
}

function queueItem(id: string, userText: string) {
  return { id, sessionId: "chat-1", userText, attachments: [], createdAt: 1, mode: "deferred" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(opts: {
  snap?: () => unknown;
  queue?: () => unknown[];
  failActions?: string[];
} = {}) {
  const calls: Call[] = [];
  const snap = opts.snap ?? (() => snapshot());
  const queue = opts.queue ?? (() => []);
  const fail = new Set(opts.failActions ?? []);
  const request = async <T,>(deviceId: string, action: string, payload?: unknown): Promise<T> => {
    calls.push({ deviceId, action, payload });
    if (fail.has(action)) throw new Error(`${action} failed`);
    if (action === "cocoSnapshot") return snap() as T;
    if (action === "listPromptQueue") return queue() as T;
    return { accepted: true } as T;
  };
  return { calls, request };
}

test("poll cadence default is 3s (single source, decision #6)", () => {
  assert.equal(COCO_POLL_MS, 3000);
});

test("refresh loads the snapshot, flips to ready, and notifies", async () => {
  const { calls, request } = harness({ snap: () => snapshot({ state: "working" }) });
  const c = new CocoController({ deviceId: "dev-1", request });
  let notified = 0;
  c.subscribe(() => { notified += 1; });
  assert.equal(c.getStatus(), "loading");
  await c.refresh();
  assert.equal(c.getStatus(), "ready");
  assert.equal(c.getSnapshot()?.state, "working");
  assert.equal(c.getQueueSessionId(), "chat-1");
  assert.ok(notified >= 1);
  assert.deepEqual(
    calls.map((x) => x.action),
    ["cocoSnapshot", "listPromptQueue"],
  );
  // chat panel open by default → queue rides along.
  assert.deepEqual(c.getQueue(), []);
});

test("first failure escalates to error; unknown action gets the upgrade hint", async () => {
  const ca = new CocoController({ deviceId: "d", request: async (_d, action) => {
    throw new Error(action === "cocoSnapshot" ? "unknown action: cocoSnapshot" : "boom");
  } });
  await ca.refresh();
  assert.equal(ca.getStatus(), "error");
  assert.match(ca.getError() ?? "", /doesn't support CoCo/);

  const cb = new CocoController({ deviceId: "d", request: async (_d, action) => {
    if (action === "cocoSnapshot") throw new Error("boom");
    return [] as never;
  } });
  await cb.refresh();
  assert.equal(cb.getError(), "boom");
});

test("transient failure after a good snapshot keeps the view ready", async () => {
  let fail = false;
  const { request } = harness({ snap: () => { if (fail) throw new Error("flaky"); return snapshot(); } });
  const c = new CocoController({ deviceId: "d", request });
  await c.refresh();
  assert.equal(c.getStatus(), "ready");
  fail = true;
  await c.refresh();
  assert.equal(c.getStatus(), "ready");
  assert.ok(c.getSnapshot());
});

test("accepted command triggers an immediate snapshot re-pull", async () => {
  const { calls, request } = harness();
  const c = new CocoController({ deviceId: "d", request });
  await c.refresh();
  calls.length = 0;
  const result = await c.command({ type: "budget", action: "reset" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.map((x) => x.action),
    ["cocoCommand", "cocoSnapshot", "listPromptQueue"],
  );
  assert.deepEqual(calls[0]?.payload, { command: { type: "budget", action: "reset" } });
});

test("failed command records the error and skips the re-pull", async () => {
  const { calls, request } = harness({ failActions: ["cocoCommand"] });
  const c = new CocoController({ deviceId: "d", request });
  await c.refresh();
  calls.length = 0;
  const result = await c.command({ type: "chatControl", action: "stop" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /cocoCommand failed/);
  assert.equal(c.getLastCommandError(), "cocoCommand failed");
  assert.equal(calls[0]?.action, "cocoCommand");
  assert.equal(calls.length, 1);
});

test("sendChat: idle routes to the chat command, working enqueues on chat.sessionId", async () => {
  const idle = harness({ snap: () => snapshot({ state: "idle" }) });
  const ci = new CocoController({ deviceId: "d", request: idle.request });
  await ci.refresh();
  idle.calls.length = 0;
  await ci.sendChat("ship it");
  assert.equal(idle.calls[0]?.action, "cocoCommand");
  assert.deepEqual(idle.calls[0]?.payload, { command: { type: "chat", text: "ship it" } });

  const busy = harness({ snap: () => snapshot({ state: "working" }) });
  const cw = new CocoController({ deviceId: "d", request: busy.request });
  await cw.refresh();
  busy.calls.length = 0;
  await cw.sendChat("after this");
  assert.equal(busy.calls[0]?.action, "enqueuePrompt");
  assert.deepEqual(busy.calls[0]?.payload, { sessionId: "chat-1", userText: "after this" });
  // queue re-pull follows the enqueue
  assert.equal(busy.calls[1]?.action, "listPromptQueue");
});

test("queue ops reuse the prompt-queue actions, not CoCo commands", async () => {
  const { calls, request } = harness({
    snap: () => snapshot(),
    queue: () => [queueItem("q1", "first"), queueItem("q2", "second")],
  });
  const c = new CocoController({ deviceId: "d", request });
  await c.refresh();
  assert.equal(c.getQueue().length, 2);
  calls.length = 0;
  await c.promotePrompt("q1");
  assert.deepEqual(
    calls.map((x) => x.action),
    ["promoteQueuedPrompt", "cocoSnapshot", "listPromptQueue", "listPromptQueue"],
  );
  assert.deepEqual(calls[0]?.payload, { sessionId: "chat-1", promptId: "q1" });
  calls.length = 0;
  await c.removePrompt("q2");
  assert.equal(calls[0]?.action, "removeQueuedPrompt");
  assert.deepEqual(calls[0]?.payload, { sessionId: "chat-1", promptId: "q2" });
});

test("poll loop runs while started and stops on stop()", async () => {
  const { calls, request } = harness();
  const c = new CocoController({ deviceId: "d", request, pollMs: 5 });
  c.start();
  await sleep(40);
  const whileRunning = calls.filter((x) => x.action === "cocoSnapshot").length;
  assert.ok(whileRunning >= 3, `expected polling, saw ${whileRunning}`);
  c.stop();
  calls.length = 0;
  await sleep(30);
  assert.equal(calls.length, 0);
});

test("background tab skips fetches but keeps the cadence", async () => {
  const { calls, request } = harness();
  let hidden = true;
  const c = new CocoController({ deviceId: "d", request, pollMs: 5, isHidden: () => hidden });
  c.start();
  await sleep(25);
  // Only the start() initial load ran — every tick was skipped.
  assert.equal(calls.filter((x) => x.action === "cocoSnapshot").length, 1);
  hidden = false;
  await sleep(25);
  assert.ok(calls.filter((x) => x.action === "cocoSnapshot").length >= 2);
  c.stop();
});

test("page + chat panel state notify and round-trip", async () => {
  const { request } = harness();
  const c = new CocoController({ deviceId: "d", request });
  const changes: string[] = [];
  c.subscribe((change) => changes.push(change));
  await c.refresh();
  changes.length = 0;
  c.setPage("rules");
  c.setPage("rules"); // no-op
  c.toggleChat(false);
  c.toggleChat(false); // no-op (already closed)
  assert.deepEqual(changes, ["ui", "ui"]);
  assert.equal(c.getPage(), "rules");
  assert.equal(c.isChatOpen(), false);
});

test("queue clears when the chat session disappears", async () => {
  let withChat = true;
  const { request } = harness({
    snap: () => snapshot(withChat ? {} : { chat: undefined }),
    queue: () => [queueItem("q1", "one")],
  });
  const c = new CocoController({ deviceId: "d", request });
  await c.refresh();
  assert.equal(c.getQueue().length, 1);
  withChat = false;
  await c.refresh();
  assert.equal(c.getQueue().length, 0);
  assert.equal(c.getQueueSessionId(), null);
});
