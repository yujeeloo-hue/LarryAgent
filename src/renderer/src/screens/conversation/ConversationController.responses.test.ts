import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
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
before(async () => { ({ ConversationController } = await import("./ConversationController.js")); });

test("hosted events refresh persisted activity and never take a local execution path", () => {
  let refreshes = 0;
  const controller = Object.assign(Object.create(ConversationController.prototype), {
    scheduleStructuralRefresh: () => { refreshes += 1; },
    pendingWriteFiles: new Map(), pendingReadFiles: new Map(), dirtyWriteStreamIds: new Set(),
    view: new Proxy({}, { get: (_target, key) => () => assert.fail(`hosted event called local view operation ${String(key)}`) }),
  });
  for (const status of ["in_progress", "completed", "failed", "incomplete"]) {
    controller.handleStreamEvent({ type: "hosted_tool", id: "native", name: "web_search_call", status, messageId: "assistant" });
  }
  assert.equal(refreshes, 4);
  assert.equal(controller.pendingWriteFiles.size, 0);
  assert.equal(controller.pendingReadFiles.size, 0);
  assert.equal(controller.dirtyWriteStreamIds.size, 0);
  controller.handleStreamEvent({ type: "hosted_tool", id: "unowned", name: "mcp_call", status: "in_progress" });
  controller.handleStreamEvent({ type: "response_state", responseId: "response", output: [{ encrypted_content: "PRIVATE" }] });
  assert.equal(refreshes, 4, "unowned/opaque events do not create transcript content");
});
