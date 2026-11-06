/**
 * Demo confirm summary card (plan §4): D7 marker user messages render as a
 * compact card — never raw JSON in the bubble; expandable key/value list.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { before, describe, it } from "node:test";
import { parseHTML } from "linkedom";

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

let createMessageView: typeof import("../message/MessageView.js")["createMessageView"];
let createMessageViewAsync: typeof import("../message/MessageView.js")["createMessageViewAsync"];
let buildMessageRenderContext: typeof import("../buildMessageRenderContext.js")["buildMessageRenderContext"];
let buildDemoConfirmMessage: typeof import("../../../../../session/demoConfirm.js")["buildDemoConfirmMessage"];
let confirmText: string;

before(async () => {
  ({ createMessageView, createMessageViewAsync } = await import(
    "../message/MessageView.js"
  ));
  ({ buildMessageRenderContext } = await import(
    "../buildMessageRenderContext.js"
  ));
  ({ buildDemoConfirmMessage } = await import(
    "../../../../../session/demoConfirm.js"
  ));
  confirmText = buildDemoConfirmMessage({
    toolCallId: "call_x",
    paramsJson: '{"height": 32, "accent": "#3b82f6"}',
    note: "denser",
  });
});

function makeCtx() {
  return buildMessageRenderContext([], {
    revealLabel: "Reveal",
    onOpenFile: () => {},
    onRevealFile: () => {},
  });
}

describe("demo confirm summary card", () => {
  it("renders the marker message as a summary card, not prose", () => {
    const row = createMessageView(
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: confirmText }],
      },
      makeCtx(),
    )!;
    assert.ok(row, "row renders");
    assert.ok(row.classList.contains("is-demo-confirm"));
    const card = row.querySelector(".content-card-demo-confirm")!;
    assert.ok(card, "summary card present");
    assert.match(
      card.querySelector(".content-card-demo-confirm-title")!.textContent!,
      /Demo confirmed · 2 params/,
    );
    assert.match(
      card.querySelector(".content-card-demo-confirm-brief")!.textContent!,
      /height=32, accent=#3b82f6/,
    );
    // Raw JSON / fence markers never appear in the bubble.
    assert.ok(!row.textContent!.includes('{"height"'));
    assert.ok(!row.textContent!.includes("```"));
    // The marker text never goes through the markdown pipeline.
    assert.equal(row.querySelector(".message-part-text"), null);
    // The clamp never wraps the card (cards are not prose).
    assert.equal(row.querySelector(".conversation-prompt-clamp"), null);
  });

  it("expands to the key/value rows and the note", () => {
    const row = createMessageView(
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: confirmText }],
      },
      makeCtx(),
    )!;
    const card = row.querySelector(
      "details.content-card-demo-confirm",
    ) as HTMLDetailsElement;
    assert.ok(!card.open, "starts closed");
    assert.ok(card.classList.contains("is-expandable"));
    const rows = card.querySelectorAll(".content-card-demo-confirm-row");
    assert.equal(rows.length, 2);
    assert.match(
      card.querySelector(".content-card-demo-confirm-note")!.textContent!,
      /Note: denser/,
    );
    card.open = true;
    assert.equal(card.open, true);
  });

  it("zero-param confirmation renders a bare title without expand", () => {
    const row = createMessageView(
      {
        id: "u3",
        role: "user",
        parts: [
          {
            type: "text",
            text: buildDemoConfirmMessage({
              toolCallId: "call_z",
              paramsJson: "{}",
            }),
          },
        ],
      },
      makeCtx(),
    )!;
    const card = row.querySelector(".content-card-demo-confirm")!;
    assert.match(
      card.querySelector(".content-card-demo-confirm-title")!.textContent!,
      /^Demo confirmed$/,
    );
    assert.equal(card.querySelector(".content-card-demo-confirm-chevron"), null);
    assert.equal(card.querySelector(".content-card-demo-confirm-row"), null);
    assert.ok(!card.classList.contains("is-expandable"));
  });

  it("non-marker user messages render normally", () => {
    const row = createMessageView(
      {
        id: "u4",
        role: "user",
        parts: [{ type: "text", text: "Please make a layout demo" }],
      },
      makeCtx(),
    )!;
    assert.equal(row.querySelector(".content-card-demo-confirm"), null);
    assert.ok(
      row.textContent!.includes("Please make a layout demo"),
      "normal prompt text renders",
    );
  });

  it("async path renders the same summary card", async () => {
    const row = await createMessageViewAsync(
      {
        id: "u5",
        role: "user",
        parts: [{ type: "text", text: confirmText }],
      },
      makeCtx(),
    );
    assert.ok(row?.querySelector(".content-card-demo-confirm"));
    assert.ok(row?.classList.contains("is-demo-confirm"));
  });
});
