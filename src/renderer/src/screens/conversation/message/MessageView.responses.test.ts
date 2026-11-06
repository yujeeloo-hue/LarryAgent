import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";
import type { MessageLike, MessageRenderContext } from "./MessageView.js";
import { RETRY_CONTINUATION_PART_ID } from "../../../../../session/types.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, HTMLElement: dom.HTMLElement, Node: dom.Node, SVGElement: dom.SVGElement });
let view: typeof import("./MessageView.js");
before(async () => { view = await import("./MessageView.js"); });

function context(): MessageRenderContext {
  return {
    toolNamesByCallId: new Map(), toolResultsByCallId: new Map(),
    plansByCreateToolCallId: new Map(), progressByToolCallId: new Map(),
    subagentsByToolCallId: new Map(), subagentNamesById: new Map(), pendingAsksByCallId: new Map(),
    revealLabel: "Reveal", onOpenFile: () => assert.fail("native file ID treated as a local path"),
    onRevealFile: () => assert.fail("native file ID treated as a local path"),
    onAbortToolCall: () => assert.fail("hosted call offered local cancellation"),
  };
}

const nativePart = {
  type: "model_response", providerScope: "scope", responseId: "resp-secret", status: "completed", stored: true,
  output: [{ type: "reasoning", encrypted_content: "OPAQUE_NATIVE_SECRET" }, { type: "message", text: "RAW_NATIVE_TEXT" }],
};

test("sync and async rendering hide all opaque native state, including native-only messages", async () => {
  const message: MessageLike = { id: "native", role: "assistant", parts: [nativePart] };
  assert.equal(view.createMessageView(message, context()), null);
  assert.equal(await view.createMessageViewAsync(message, context()), null);
});

test("hidden retry-continuation prompts render no row in both render paths", async () => {
  const message: MessageLike = {
    id: "retry-continuation",
    role: "user",
    parts: [
      {
        type: "text",
        text: "The previous turn was interrupted by an error before the task finished…",
        id: RETRY_CONTINUATION_PART_ID,
      },
    ],
  };
  assert.equal(view.createMessageView(message, context()), null);
  assert.equal(await view.createMessageViewAsync(message, context()), null);
});

test("hosted replay renders activity and citations in both render paths without local tool bookkeeping", async () => {
  const message: MessageLike = { id: "assistant", role: "assistant", parts: [
    { type: "hosted_tool", id: "search", name: "web_search_call", status: "completed", item: { action: { query: "JellyBot" } } },
    { type: "text", text: "Found the documentation.", annotations: [{ type: "url_citation", url: "https://example.com/docs", title: "Documentation" }] },
    nativePart,
  ] };
  for (const render of [view.createMessageView, view.createMessageViewAsync]) {
    const ctx = context();
    const row = await render(message, ctx);
    assert.ok(row);
    assert.equal(row.querySelectorAll(".content-card-hosted-tool").length, 1);
    assert.equal(row.querySelector("a.response-reference")?.getAttribute("href"), "https://example.com/docs");
    assert.match(row.textContent!, /Web searchCompletedJellyBot/);
    assert.doesNotMatch(row.outerHTML, /OPAQUE_NATIVE_SECRET|RAW_NATIVE_TEXT|resp-secret/);
    assert.equal(ctx.toolNamesByCallId.size, 0);
    assert.equal(ctx.pendingAsksByCallId.size, 0);
    assert.equal(row.querySelector("button"), null);
  }
});

test("native file save buttons carry owning session/message and exact container reference", async () => {
  const requests: unknown[] = [];
  window.jellybot = { downloadResponseFile: async (request: unknown) => {
    requests.push(request); return { ok: true, path: "/saved/report.csv" };
  } } as unknown as NonNullable<Window["jellybot"]>;
  const message: MessageLike = { id: "owner-message", role: "assistant", parts: [
    { type: "text", text: "Report ready.", annotations: [
      { type: "container_file_citation", file_id: "cfile-report", container_id: "cntr-report", filename: "report.csv" },
    ] },
    { type: "hosted_tool", id: "code", name: "code_interpreter_call", status: "completed", item: {
      container_id: "cntr-code", outputs: [{ files: [{ file_id: "cfile-chart", filename: "chart.png" }] }],
    } },
  ] };
  for (const render of [view.createMessageView, view.createMessageViewAsync]) {
    const row = await render(message, { ...context(), sessionId: "owner-session" });
    const buttons = row!.querySelectorAll<HTMLButtonElement>("button.response-reference-download");
    assert.equal(buttons.length, 2);
    for (const button of buttons) button.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.equal(row!.querySelectorAll('.response-reference-feedback[role="status"]').length, 2);
    assert.equal(row!.querySelector(".response-reference-feedback")?.textContent, "Saved");
  }
  assert.deepEqual(requests, [0, 1].flatMap(() => [
    { sessionId: "owner-session", messageId: "owner-message", fileId: "cfile-report", containerId: "cntr-report", filename: "report.csv" },
    { sessionId: "owner-session", messageId: "owner-message", fileId: "cfile-chart", containerId: "cntr-code", filename: "chart.png" },
  ]));
  const unowned = view.createMessageView(message, context());
  assert.equal(unowned!.querySelector("button.response-reference-download"), null, "unowned references cannot request downloads");
});
