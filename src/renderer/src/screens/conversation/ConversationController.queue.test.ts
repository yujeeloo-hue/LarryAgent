import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });

let ConversationController: typeof import("./ConversationController.js").ConversationController;
let PromptQueueView: typeof import("./PromptQueueView.js").PromptQueueView;
test.before(async () => {
  ({ ConversationController } = await import("./ConversationController.js"));
  ({ PromptQueueView } = await import("./PromptQueueView.js"));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  let prompt = "queued instructions";
  let stopCalls = 0;
  const enqueues: Array<{ mode: string; userText: string }> = [];
  const promotions: string[] = [];
  const reply = deferred<{ ok: boolean; items: QueuedPrompt[] }>();
  const item: QueuedPrompt = {
    id: "queued", text: prompt, attachments: [], mode: "deferred", createdAt: 1,
  };
  window.jellybot = {
    enqueuePrompt: async (req: { mode: string; userText: string }) => {
      enqueues.push(req);
      return reply.promise;
    },
    promoteQueuedPrompt: async (_sessionId: string, id: string) => {
      promotions.push(id);
      return { ok: true, started: false, items: [{ ...item, mode: "interrupt" }] };
    },
    cancelTurn: async () => { stopCalls += 1; return true; },
  } as unknown as NonNullable<Window["jellybot"]>;
  const view = {
    getPrompt: () => prompt,
    clearPrompt: () => { prompt = ""; },
    composer: {
      trySubmitSlashCommand: () => false,
      setPrompt: (text: string) => { prompt = text; },
    },
    sendButton: { disabled: false },
    setSendEnabled(enabled: boolean) { this.sendButton.disabled = !enabled; },
    setStopMode: () => {},
    setPromptQueue: () => {},
    setPromptQueueIdle: () => {},
    focusInput: () => {},
  };
  const controller = Object.assign(Object.create(ConversationController.prototype), {
    view,
    sessionId: "session",
    sessionStatus: "running",
    sending: true,
    composerSubmitting: false,
    composerEnqueuePending: false,
    insertAfterEnqueue: false,
    promptQueue: [],
    draftSaveTimer: null,
    trySlashModeSwitch: () => {},
    tryOptimizePrompt: async () => false,
  });
  return {
    controller, enqueues, promotions, item, reply,
    prompt: () => prompt,
    setPrompt: (text: string) => { prompt = text; },
    stops: () => stopCalls,
    enter: () => controller.runComposerSubmitAction({ respectDisabled: true }) as Promise<void>,
  };
}

test("first Enter queues deferred; only the next empty Enter promotes it", async () => {
  const h = harness();
  const first = h.enter();
  await Promise.resolve();
  assert.equal(h.enqueues.length, 1);
  assert.equal(h.enqueues[0]!.mode, "deferred");
  assert.equal(h.prompt(), "");
  assert.deepEqual(h.promotions, []);
  h.reply.resolve({ ok: true, items: [h.item] });
  await first;
  assert.deepEqual(h.promotions, []);
  await h.enter();
  assert.deepEqual(h.promotions, [h.item.id]);
  assert.equal(h.stops(), 0);
});

test("rapid submits never enqueue the same draft twice or accidentally Stop while awaiting the queue", async () => {
  const h = harness();
  const first = h.enter();
  // Reentry before the async composer precheck finishes still sees the text.
  await h.enter();
  assert.equal(h.enqueues.length, 1);
  assert.equal(h.prompt(), "");
  // A second deliberate Enter on the cleared composer waits for the reply.
  await h.enter();
  await h.enter();
  assert.equal(h.stops(), 0);
  h.reply.resolve({ ok: true, items: [h.item] });
  await first;
  assert.equal(h.enqueues.length, 1);
  assert.deepEqual(h.promotions, [h.item.id]);
});

test("enqueue reply preserves the next draft typed while IPC was in flight", async () => {
  const h = harness();
  const first = h.enter();
  await Promise.resolve();
  h.setPrompt("next draft");
  h.reply.resolve({ ok: true, items: [h.item] });
  await first;
  assert.equal(h.prompt(), "next draft");
  assert.deepEqual(h.promotions, []);
});

test("pending second Enter does not start another turn if this turn settles first", async () => {
  const h = harness();
  const first = h.enter();
  await Promise.resolve();
  await h.enter();
  h.controller.sending = false;
  h.controller.sessionStatus = "idle";
  h.reply.resolve({ ok: true, items: [] });
  await first;
  assert.deepEqual(h.promotions, []);
  assert.equal(h.stops(), 0);
});

test("Stop on an empty composer and consumed queue adds no user prompt", async () => {
  const h = harness();
  h.setPrompt("");
  await h.enter();
  assert.equal(h.stops(), 1);
  assert.equal(h.enqueues.length, 0);
  assert.deepEqual(h.promotions, []);
});

test("queue controls explain natural insertion and preserve arm/cancel actions", () => {
  const view = new PromptQueueView();
  const promoted: string[] = [];
  const deferred: string[] = [];
  view.setHandlers({ onPromote: (id) => promoted.push(id), onDefer: (id) => deferred.push(id),
    onRemove: () => {}, onUpdateText: () => {}, onMoveToFront: () => {} });
  const item = { id: "next-direction", text: "A new direction", attachments: [] };
  view.setItems([{ ...item, mode: "deferred" }]);
  const insert = view.root.querySelector<HTMLButtonElement>(".is-promote")!;
  assert.equal(insert.title, "Insert into this turn after the current step finishes");
  insert.click();
  assert.deepEqual(promoted, [item.id]);
  view.setItems([{ ...item, mode: "interrupt" }]);
  assert.equal(view.root.querySelector(".prompt-queue-row-state")!.textContent, "Next step");
  assert.equal(view.root.querySelector(".prompt-queue-head-hint")!.textContent, "inserts after the current step");
  assert.equal(view.root.querySelector<HTMLElement>(".prompt-queue-row-state")!.title,
    "Inserts after the current model request and tools finish");
  view.root.querySelector<HTMLButtonElement>(".is-promote")!.click();
  assert.deepEqual(deferred, [item.id]);
});

test("a read-only background transcript cannot retry, reclaim, or abort its owned task", async () => {
  const controller = Object.create(ConversationController.prototype) as any;
  controller.readOnly = true;
  let mutations = 0;
  controller.retryOverride = async () => { mutations++; return true; };
  controller.attachmentsApi = { getAttachments: () => [] };
  window.jellybot = { abortToolCall: () => { mutations++; }, removeTurnError: () => { mutations++; } } as any;
  assert.equal(await controller.retryTurnError({ continuation: "retry", errorMessageId: "saved-error" }), false);
  controller.reclaimRunningPrompt();
  controller.abortToolCall("background-read");
  assert.equal(mutations, 0);
});
