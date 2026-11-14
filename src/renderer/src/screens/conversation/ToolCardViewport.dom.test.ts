import assert from "node:assert/strict";
import Module from "node:module";
import { afterEach, before, describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";
import hljs from "highlight.js/lib/core";

(Module as unknown as { _extensions: Record<string, () => void> })
  ._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
});

let cards: typeof import("./cards/virtualToolCard.js");
let createToolInvocationCard: typeof import("./cards/ToolInvocationCardView.js")["createToolInvocationCard"];
let updateStreamingWritePreviewCard: typeof import("./cards/streamingWritePreview.js")["updateStreamingWritePreviewCard"];
let ToolCardViewport: typeof import("./ToolCardViewport.js")["ToolCardViewport"];
let buildMessageRenderContext: typeof import("./buildMessageRenderContext.js")["buildMessageRenderContext"];
let createMessageView: typeof import("./message/MessageView.js")["createMessageView"];
let onCardDispose: typeof import("./cards/cardResources.js")["onCardDispose"];
const viewports: InstanceType<typeof ToolCardViewport>[] = [];

before(async () => {
  cards = await import("./cards/virtualToolCard.js");
  ({ createToolInvocationCard } = await import("./cards/ToolInvocationCardView.js"));
  ({ updateStreamingWritePreviewCard } = await import("./cards/streamingWritePreview.js"));
  ({ ToolCardViewport } = await import("./ToolCardViewport.js"));
  ({ buildMessageRenderContext } = await import("./buildMessageRenderContext.js"));
  ({ createMessageView } = await import("./message/MessageView.js"));
  ({ onCardDispose } = await import("./cards/cardResources.js"));
});

afterEach(() => {
  for (const viewport of viewports.splice(0)) viewport.destroy();
  document.body.replaceChildren();
  mock.restoreAll();
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const content = "const value = 1;";
function input(id: string, name = "write_file") {
  return {
    id, name, status: "done", argumentsRaw: "{}",
    arguments: { path: `/tmp/${id}.ts`, content, old_string: "old", new_string: content },
    result: { returnCode: 0, content: [{ type: "text", text: `Updated /tmp/${id}.ts` }] },
  };
}

function transcript() {
  const list = document.createElement("div");
  document.body.append(list);
  const viewport = new ToolCardViewport(list, list);
  viewports.push(viewport);
  return { list, viewport };
}

function openIds(list: HTMLElement) {
  return Array.from(list.querySelectorAll<HTMLElement>(".conversation-tool-slot"))
    .filter((slot) => cards.getVirtualToolCardOpen(slot))
    .map((slot) => slot.dataset.toolCallId);
}

describe("conversation code card budget", () => {
  it("shares five slots across Patch/Write families and across turns on history load", () => {
    const names = ["write_file", "patch", "append_file", "edit_file", "write_plan_doc", "patch", "write_file", "patch"];
    const messages = names.flatMap((name, i) => {
      const tool = input(`call-${i}`, name);
      return [
        { role: "user", parts: [{ type: "text", text: "Continue" }] },
        { role: "assistant", parts: [{ type: "tool_call", ...tool }] },
        { role: "tool", parts: [{ type: "tool_result", toolCallId: tool.id, ...tool.result }] },
      ];
    });
    const ctx = buildMessageRenderContext(messages, {
      revealLabel: "Reveal", onOpenFile() {}, onRevealFile() {},
    });
    const { list } = transcript();
    for (const message of messages) {
      const row = createMessageView(message, ctx);
      if (row) list.append(row);
    }
    assert.equal(list.querySelectorAll(".conversation-tool-slot").length, 8);
    assert.deepEqual(openIds(list), ["call-3", "call-4", "call-5", "call-6", "call-7"]);
    for (const id of ["call-0", "call-1", "call-2"]) {
      assert.equal(list.querySelector(`[data-tool-call-id='${id}'] .content-card-tool-invocation-body`), null);
    }
  });

  it("never highlights older history, even during initial creation", () => {
    const highlight = mock.method(hljs, "highlight");
    const tools = Array.from({ length: 30 }, (_, i) => input(`write-${i}`));
    const messages = tools.flatMap((tool) => [
      { role: "assistant", parts: [{ type: "tool_call", ...tool }] },
      { role: "tool", parts: [{ type: "tool_result", toolCallId: tool.id, ...tool.result }] },
    ]);
    const ctx = buildMessageRenderContext(messages, {
      revealLabel: "Reveal", onOpenFile() {}, onRevealFile() {},
    });
    const { list } = transcript();
    for (const message of messages) {
      const row = createMessageView(message, ctx);
      if (row) list.append(row);
    }
    assert.equal(highlight.mock.callCount(), 5);
    assert.equal(list.querySelectorAll(".tool-file-lines").length, 5);
  });

  it("collapses oldest live cards, releases body work, and allows inspecting an old card within the budget", async () => {
    const { list } = transcript();
    const slots = Array.from({ length: 5 }, (_, i) => createToolInvocationCard(input(`live-${i}`, i % 2 ? "patch" : "write_file")));
    list.append(...slots);
    await flush();
    let cleaned = 0;
    onCardDispose(slots[0]!.querySelector<HTMLElement>(".content-card-tool-invocation-body")!, () => { cleaned += 1; });
    list.append(createToolInvocationCard(input("live-5", "patch")));
    await flush();
    assert.deepEqual(openIds(list), ["live-1", "live-2", "live-3", "live-4", "live-5"]);
    assert.equal(cleaned, 1, "body cleanup runs when the sixth card arrives");
    assert.equal(slots[0]!.querySelector(".content-card-tool-invocation-body"), null);

    const old = slots[0]!.firstElementChild as HTMLDetailsElement;
    old.open = true;
    old.dispatchEvent(new dom.window.Event("toggle", { bubbles: true }));
    assert.deepEqual(openIds(list), ["live-0", "live-2", "live-3", "live-4", "live-5"]);
    assert.equal(list.querySelectorAll(".content-card-tool-invocation-body").length, 5);
  });

  it("does no rendering/highlighting for closed streaming chunks and reopens with the latest text", () => {
    const slot = createToolInvocationCard({
      ...input("stream"), result: undefined, status: "pending", previewContent: content,
    });
    cards.setVirtualToolCardOpen(slot, false);
    const highlight = mock.method(hljs, "highlight");
    for (let i = 0; i < 20; i += 1) {
      assert.equal(updateStreamingWritePreviewCard(slot, {
        name: "write_file", argumentsRaw: "{}",
        arguments: { path: "/tmp/latest.ts", content: `const latest = ${i};` },
        previewContent: `const latest = ${i};`,
      }), true);
    }
    assert.equal(highlight.mock.callCount(), 0);
    assert.equal(slot.querySelector(".content-card-tool-invocation-body"), null);
    assert.match(slot.textContent ?? "", /latest.ts/);
    cards.setVirtualToolCardOpen(slot, true);
    assert.match(slot.querySelector(".tool-file-lines")?.textContent ?? "", /const latest = 19;/);
    assert.equal(highlight.mock.callCount(), 1);
  });

  it("restores a closed offscreen card without rebuilding code and preserves its scroll state", () => {
    const slot = createToolInvocationCard(input("offscreen"));
    slot.querySelector<HTMLElement>(".tool-file-lines")!.scrollTop = 42;
    cards.setVirtualToolCardOpen(slot, false);
    cards.suspendVirtualToolCard(slot, 100);
    const highlight = mock.method(hljs, "highlight");
    cards.resumeVirtualToolCard(slot);
    assert.equal(highlight.mock.callCount(), 0);
    assert.equal(slot.querySelector(".content-card-tool-invocation-body"), null);
    cards.setVirtualToolCardOpen(slot, true);
    assert.equal(slot.querySelector<HTMLElement>(".tool-file-lines")!.scrollTop, 42);
  });

  it("applies the budget to suspended cards so scrolling back cannot reopen old content", async () => {
    const { list } = transcript();
    const slots = Array.from({ length: 5 }, (_, i) => createToolInvocationCard(input(`suspended-${i}`)));
    list.append(...slots);
    await flush();
    cards.suspendVirtualToolCard(slots[0]!, 200);
    list.append(createToolInvocationCard(input("newest")));
    await flush();
    assert.equal(cards.getVirtualToolCardOpen(slots[0]!), false);
    cards.resumeVirtualToolCard(slots[0]!);
    assert.equal(slots[0]!.querySelector(".content-card-tool-invocation-body"), null);
    assert.equal(openIds(list).length, 5);
  });
});
