import assert from "node:assert/strict";
import test from "node:test";
import { CocoPromptQueueController } from "./CocoPromptQueueController.js";

type Bridge = NonNullable<ReturnType<ConstructorParameters<typeof CocoPromptQueueController>[0]>>;
const item = (id: string, sessionId = "chat", mode: QueuedPromptMode = "deferred"): QueuedPrompt => ({ id, sessionId, userText: id, mode, attachments: [], createdAt: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<Bridge> = {}) {
  const calls: unknown[][] = [], errors: string[] = [];
  const mutation = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return { ok: true, items: [] }; };
  const bridge: Bridge = {
    listPromptQueue: async () => [],
    enqueuePrompt: async req => { calls.push(["enqueue", req]); const queued = item(req.userText, req.sessionId); return { queued, items: [queued] }; },
    removeQueuedPrompt: mutation("remove"), updateQueuedPromptText: mutation("edit"), moveQueuedPromptToFront: mutation("front"),
    promoteQueuedPrompt: mutation("promote"), deferQueuedPrompt: mutation("defer"), ...overrides,
  };
  let renders = 0;
  const controller = new CocoPromptQueueController(() => bridge, () => { renders++; }, text => errors.push(text));
  const stream = (items: QueuedPrompt[], sessionId = "chat") => controller.onStream({ sessionId, event: { type: "prompt_queue", items } });
  return { controller, stream, calls, errors, get renders() { return renders; } };
}

test("late hydration cannot replay an item already consumed by the live queue", async () => {
  const load = deferred<QueuedPrompt[]>(), f = fixture({ listPromptQueue: () => load.promise });
  f.controller.setSession("chat"); f.stream([item("new")]); f.stream([]);
  load.resolve([item("stale")]); await load.promise; await Promise.resolve();
  assert.deepEqual(f.controller.viewItems, []);
  f.controller.destroy();
});

test("queue subscriptions ignore other sessions and restore retained rows on re-entry", async () => {
  const f = fixture({ listPromptQueue: async id => [item("retained", id)] });
  f.controller.setSession("chat"); await Promise.resolve();
  f.stream([item("wrong", "other")], "other");
  assert.equal(f.controller.viewItems[0]?.text, "retained");
  f.controller.setSession(""); assert.deepEqual(f.controller.viewItems, []);
  f.controller.setSession("chat"); await Promise.resolve();
  assert.equal(f.controller.hasDeferred, true);
  f.controller.destroy(); f.stream([item("late")]); assert.deepEqual(f.controller.viewItems, []);
});

test("a fast second Enter arms the first deferred prompt after enqueue acknowledgement", async () => {
  const enqueue = deferred<EnqueuePromptResponse>(), f = fixture({ enqueuePrompt: req => { f.calls.push(["enqueue", req]); return enqueue.promise; } });
  f.controller.setSession("chat"); await Promise.resolve();
  const sending = f.controller.enqueue("correction", "work-ref");
  assert.equal(f.controller.enqueuePending, true);
  f.controller.insertAfterEnqueue();
  const queued = item("correction"); enqueue.resolve({ queued, items: [queued] });
  assert.equal(await sending, true);
  assert.deepEqual(f.calls, [["enqueue", { sessionId: "chat", userText: "correction", mode: "deferred", cocoWorkId: "work-ref" }], ["promote", "chat", "correction"]]);
  assert.equal(f.controller.enqueuePending, false);
});

test("old enqueue acknowledgements cannot clear a new pending operation after switching away and back", async () => {
  const old = deferred<EnqueuePromptResponse>(), fresh = deferred<EnqueuePromptResponse>();
  let count = 0;
  const f = fixture({ enqueuePrompt: () => ++count === 1 ? old.promise : fresh.promise });
  f.controller.setSession("chat"); await Promise.resolve();
  const first = f.controller.enqueue("old");
  f.controller.setSession("other"); f.controller.setSession("chat"); await Promise.resolve();
  const second = f.controller.enqueue("fresh");
  old.resolve({ queued: item("old"), items: [item("old")] });
  assert.equal(await first, false);
  assert.equal(f.controller.enqueuePending, true);
  fresh.resolve({ queued: item("fresh"), items: [item("fresh")] });
  assert.equal(await second, true);
  assert.equal(f.controller.viewItems[0]?.text, "fresh");
});

test("IPC replies cannot overwrite a newer prompt_queue event", async () => {
  const pending = deferred<PromptQueueMutationResponse>(), f = fixture({ promoteQueuedPrompt: () => pending.promise });
  f.controller.setSession("chat"); await Promise.resolve();
  f.stream([item("correction")]); const operation = f.controller.promoteHead();
  f.stream([]); pending.resolve({ ok: true, items: [item("correction", "chat", "interrupt")] });
  await operation; assert.deepEqual(f.controller.viewItems, []);
});

test("all row actions target the bound session and failures keep the latest queue visible", async () => {
  const f = fixture({ promoteQueuedPrompt: async () => ({ ok: false, reason: "coco_unavailable", items: [item("kept")] }) });
  f.controller.setSession("chat"); await Promise.resolve();
  const h = f.controller.handlers;
  h.onRemove("a"); h.onUpdateText("b", "edited"); h.onMoveToFront("c"); h.onDefer("d");
  await Promise.resolve();
  assert.deepEqual(f.calls, [["remove", "chat", "a"], ["edit", "chat", "b", "edited"], ["front", "chat", "c"], ["defer", "chat", "d"]]);
  f.stream([item("kept")]); await f.controller.promoteHead();
  assert.equal(f.controller.viewItems[0]?.text, "kept");
  assert.match(f.errors[0]!, /kept in the queue/);
});

test("enqueue failures release the submit lock without clearing the existing queue", async () => {
  const f = fixture({ enqueuePrompt: async () => { throw new Error("queue full"); } });
  f.controller.setSession("chat"); await Promise.resolve(); f.stream([item("kept")]);
  assert.equal(await f.controller.enqueue("retry me"), false);
  assert.equal(f.controller.enqueuePending, false);
  assert.equal(f.controller.viewItems[0]?.text, "kept"); assert.match(f.errors[0]!, /queue full/);
});
