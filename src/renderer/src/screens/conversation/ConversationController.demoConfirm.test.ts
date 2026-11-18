import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import { parseDemoConfirmMessage } from "../../../../session/demoConfirm.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });
let Controller: typeof import("./ConversationController.js").ConversationController;
test.before(async () => { ({ ConversationController: Controller } = await import("./ConversationController.js")); });

function harness(status = "running") {
  const requests: Array<Record<string, unknown>> = [];
  let refreshes = 0;
  window.jellybot = {
    enqueuePrompt: async (request: Record<string, unknown>) => {
      requests.push(request);
      return { items: [{ id: "queue", userText: request.userText, attachments: [], mode: "deferred", createdAt: 1 }] };
    },
  } as unknown as NonNullable<Window["jellybot"]>;
  const controller = Object.assign(Object.create(Controller.prototype), {
    destroyed: false, sessionId: "correct-session", sessionStatus: status, sending: false,
    promptQueue: [], demoStates: new Map(),
    view: { setPromptQueue: () => {}, setPromptQueueIdle: () => {} },
    syncSendEnabled: () => {}, scheduleStructuralRefresh: () => { refreshes += 1; },
    startFollowUpTurn: async (text: string) => { requests.push({ sessionId: "correct-session", userText: text }); },
  });
  return { controller, requests, refreshes: () => refreshes };
}

test("desktop Confirm returns a queue receipt with the correct session, tool and note", async () => {
  const h = harness();
  assert.deepEqual(await h.controller.submitDemoConfirm("demo-call", { count: 7 }, "chosen"), { enqueued: true });
  assert.equal(h.requests[0]!.sessionId, "correct-session");
  assert.equal(h.requests[0]!.mode, "deferred");
  assert.deepEqual(parseDemoConfirmMessage(String(h.requests[0]!.userText)), { toolCallId: "demo-call", paramsJson: '{"count":7}', note: "chosen" });
  assert.equal(h.refreshes(), 1);
  h.controller.applyPromptQueueSnapshot([]);
  assert.equal(h.refreshes(), 2, "queue removal refreshes settled demo state");
});

test("desktop queue failure propagates to the card for Retry", async () => {
  const h = harness();
  window.jellybot!.enqueuePrompt = async () => { throw new Error("Queue is full"); };
  await assert.rejects(h.controller.submitDemoConfirm("demo-call", { count: 7 }), /Queue is full/);
  assert.equal(h.controller.promptQueue.length, 0);
  assert.equal(h.refreshes(), 0);
});

test("idle Confirm returns a start receipt, while a start failure remains observable", async () => {
  const h = harness("idle");
  assert.deepEqual(await h.controller.submitDemoConfirm("demo-call", { count: 8 }), { enqueued: false });
  assert.equal(h.requests.length, 1);
  h.controller.startFollowUpTurn = async () => { throw new Error("Provider unavailable"); };
  await assert.rejects(h.controller.submitDemoConfirm("demo-call", { count: 8 }), /Provider unavailable/);
});
