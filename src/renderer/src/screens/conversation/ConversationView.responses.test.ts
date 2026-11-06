import assert from "node:assert/strict";
import Module from "node:module";
import { before, test, mock } from "node:test";
import hljs from "highlight.js/lib/core";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document, window: dom.window, HTMLElement: dom.HTMLElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Node: dom.Node, CSS: { escape: (value: string) => value },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
});
let ConversationView: typeof import("./ConversationView.js").ConversationView;
let buildMessageRenderContext: typeof import("./buildMessageRenderContext.js").buildMessageRenderContext;
before(async () => {
  ({ ConversationView } = await import("./ConversationView.js"));
  ({ buildMessageRenderContext } = await import("./buildMessageRenderContext.js"));
});

test("mixed local and hosted responses paint only the reply and its citations", async () => {
  const list = document.createElement("div");
  list.innerHTML = '<article class="conversation-msg" data-message-id="assistant"><div class="conversation-msg-body"><section data-tool-call-id="local">old local</section></div></article>';
  const view = Object.assign(Object.create(ConversationView.prototype), {
    messagesListEl: list, reasoningMessageId: null,
    syncPlanCards: () => {}, layoutTurns: () => {}, scrollToBottomIfStuck: () => {},
    revealNewAskCard: () => false,
  });
  for (const status of ["in_progress", "completed"]) {
    const assistant = { id: "assistant", role: "assistant", parts: [
      { type: "tool_call", id: "local", name: "custom_local_tool", status: "done", arguments: {}, argumentsRaw: "{}" },
      { type: "hosted_tool", id: "native", name: "web_search_call", status },
      { type: "text", text: `Native status ${status}`, annotations: [{ type: "url_citation", url: "https://example.com/docs", title: "Docs" }] },
    ] };
    const toolResult = { role: "tool", parts: [{ type: "tool_result", toolCallId: "local", returnCode: 0, content: [{ type: "text", text: "done" }] }] };
    const ctx = buildMessageRenderContext([assistant, toolResult], { revealLabel: "Reveal", onOpenFile: () => {}, onRevealFile: () => {} });
    assert.equal(await view.upsertAssistantMessage(assistant, ctx), true);
    // Outside the card allowlist: neither the local tool nor the hosted call paints.
    assert.equal(list.querySelectorAll('[data-tool-call-id="local"]').length, 0);
    assert.equal(list.querySelectorAll('[data-hosted-tool-id="native"]').length, 0);
    assert.equal(list.querySelector("a.response-reference")?.textContent, "Docs");
    assert.match(list.textContent!, new RegExp(`Native status ${status}`));
  }
});

test("hosted row rebuild retains the exact live write preview node", () => {
  const current = document.createElement("article");
  current.innerHTML = '<div class="conversation-msg-body"><section data-tool-call-id="write" data-tool-streaming="1">partial write</section></div>';
  const next = document.createElement("article");
  next.innerHTML = '<div class="conversation-msg-body"><section class="content-card-hosted-tool">search completed</section></div>';
  const preview = current.querySelector('[data-tool-streaming="1"]')!;
  const view = Object.create(ConversationView.prototype);
  assert.equal(view.patchToolCardsInPlace(current, next), false);
  assert.equal(next.querySelector('[data-tool-streaming="1"]'), preview);
  assert.match(next.textContent!, /search completedpartial write/);
});

test("a failed Patch closes its preview and keeps later user expansion on refresh", async () => {
  const { createToolInvocationCard } = await import("./cards/ToolInvocationCardView.js");
  const { getVirtualToolCardOpen, setVirtualToolCardOpen } = await import("./cards/virtualToolCard.js");
  const list = document.createElement("div");
  list.innerHTML = '<article class="conversation-msg" data-message-id="assistant"><div class="conversation-msg-body"></div></article>';
  document.body.append(list);
  const args = { path: "/tmp/a.ts", old_string: "old", new_string: "new" };
  const preview = createToolInvocationCard({ id: "patch", name: "patch", status: "running", arguments: args, argumentsRaw: "{}" });
  list.querySelector(".conversation-msg-body")!.append(preview);
  setVirtualToolCardOpen(preview, true);
  const part = { type: "tool_call", id: "patch", name: "patch", status: "error", arguments: args };
  const ctx = buildMessageRenderContext([
    { role: "assistant", parts: [part] },
    { role: "tool", parts: [{ type: "tool_result", toolCallId: "patch", returnCode: 1, content: [{ type: "text", text: "PATCH FAILED — no matches" }] }] },
  ], { revealLabel: "Reveal", onOpenFile() {}, onRevealFile() {} });
  const view = Object.assign(Object.create(ConversationView.prototype), {
    messagesListEl: list, syncPlanCards() {}, layoutTurns() {}, scrollToBottomIfStuck() {},
  });
  try {
    assert.equal(view.upsertFinishedToolCard("assistant", "patch", part, ctx), true);
    const failed = list.querySelector<HTMLElement>('[data-tool-call-id="patch"]')!;
    assert.equal(failed.hidden, false);
    assert.equal(getVirtualToolCardOpen(failed), false, "failure folds the running preview");
    setVirtualToolCardOpen(failed, true);
    assert.equal(view.upsertFinishedToolCard("assistant", "patch", part, ctx), true);
    const refreshed = list.querySelector<HTMLElement>('[data-tool-call-id="patch"]')!;
    assert.equal(getVirtualToolCardOpen(refreshed), true, "later refresh preserves user expansion");
  } finally { list.remove(); }
});

test("closed Write cards stay unrendered during finished and assistant snapshot replacements", async () => {
  const { createToolInvocationCard } = await import("./cards/ToolInvocationCardView.js");
  const { getVirtualToolCardOpen, setVirtualToolCardOpen } = await import("./cards/virtualToolCard.js");
  const list = document.createElement("div");
  list.innerHTML = '<article class="conversation-msg" data-message-id="assistant"><div class="conversation-msg-body"></div></article>';
  document.body.append(list);
  const args = { path: "/tmp/a.ts", content: "const fresh = true;" };
  const preview = createToolInvocationCard({ id: "write", name: "write_file", status: "running", arguments: args, argumentsRaw: "{}" });
  list.querySelector(".conversation-msg-body")!.append(preview);
  setVirtualToolCardOpen(preview, false);
  const part = { type: "tool_call", id: "write", name: "write_file", status: "done", arguments: args };
  const assistant = { id: "assistant", role: "assistant", parts: [part] };
  const ctx = buildMessageRenderContext([
    assistant,
    { role: "tool", parts: [{ type: "tool_result", toolCallId: "write", returnCode: 0, content: [] }] },
  ], { revealLabel: "Reveal", onOpenFile() {}, onRevealFile() {} });
  const view = Object.assign(Object.create(ConversationView.prototype), {
    messagesListEl: list, syncPlanCards() {}, layoutTurns() {}, scrollToBottomIfStuck() {},
    revealNewAskCard: () => false,
  });
  const highlight = mock.method(hljs, "highlight");
  try {
    assert.equal(view.upsertFinishedToolCard("assistant", "write", part, ctx), true);
    assert.equal(await view.upsertAssistantMessage(assistant, ctx), true);
    const card = list.querySelector<HTMLElement>('[data-tool-call-id="write"]')!;
    assert.equal(getVirtualToolCardOpen(card), false);
    assert.equal(card.querySelector(".content-card-tool-invocation-body"), null);
    assert.equal(highlight.mock.callCount(), 0, "replacements never highlight hidden code");
    setVirtualToolCardOpen(card, true);
    assert.match(card.textContent ?? "", /const fresh = true/);
  } finally {
    highlight.mock.restore();
    list.remove();
  }
});
