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

let createMessageView: typeof import("./message/MessageView.js")["createMessageView"];
let buildMessageRenderContext: typeof import("./buildMessageRenderContext.js")["buildMessageRenderContext"];
let createNewTaskCard: typeof import("./cards/NewTaskCardView.js")["createNewTaskCard"];
let splitMessagesIntoTurns: typeof import("./turnModifiedFiles.js")["splitMessagesIntoTurns"];
let isNewTaskBoundaryMessage: typeof import("./turnModifiedFiles.js")["isNewTaskBoundaryMessage"];

before(async () => {
  ({ createMessageView } = await import("./message/MessageView.js"));
  ({ buildMessageRenderContext } = await import("./buildMessageRenderContext.js"));
  ({ createNewTaskCard } = await import("./cards/NewTaskCardView.js"));
  ({ splitMessagesIntoTurns, isNewTaskBoundaryMessage } = await import(
    "./turnModifiedFiles.js"
  ));
});

function boundaryMessage(): {
  id: string;
  role: string;
  createdAt: number;
  parts: Array<Record<string, unknown>>;
} {
  return {
    id: "boundary-1",
    role: "system",
    createdAt: 3,
    parts: [
      {
        type: "context_new_task",
        id: "boundary-part",
        reason: "unrelated_prompt",
        hiddenMessageCount: 2,
      },
    ],
  };
}

describe("New Task divider", () => {
  it("renders the label with the shared divider chrome", () => {
    const card = createNewTaskCard();
    assert.equal(card.className, "content-card-compaction-hint");
    const label = card.querySelector(".content-card-compaction-label");
    assert.equal(label?.textContent, "New Task");
    assert.equal(card.querySelectorAll(".content-card-compaction-rule").length, 2);
  });

  it("renders as a compaction-styled row through the message view", () => {
    const ctx = buildMessageRenderContext([], {
      sessionStatus: "idle",
    } as never);
    const row = createMessageView(boundaryMessage() as never, ctx);
    assert.ok(row, "the boundary must paint a row");
    assert.equal(row.classList.contains("conversation-msg-compaction"), true);
    assert.equal(
      row.querySelector(".content-card-compaction-label")?.textContent,
      "New Task",
    );
  });

  it("opens its own turn group so the divider sits above the prompt", () => {
    const messages = [
      { id: "u1", role: "user", createdAt: 1, parts: [{ type: "text", text: "old" }] },
      { id: "a1", role: "assistant", createdAt: 2, parts: [{ type: "text", text: "done" }] },
      boundaryMessage(),
      { id: "u2", role: "user", createdAt: 4, parts: [{ type: "text", text: "new" }] },
    ];
    assert.equal(isNewTaskBoundaryMessage(boundaryMessage()), true);
    const turns = splitMessagesIntoTurns(messages as never);
    assert.equal(turns.length, 3);
    assert.equal(turns[1]!.length, 1);
    assert.equal(turns[2]![0]!.id, "u2");
  });
});
