/**
 * DOM tests: offscreen lifecycle of virtualized Write/Patch tool cards.
 *
 * Write-family cards keep a stable slot in the transcript. When the slot
 * leaves the viewport its card DOM is destroyed (not hidden) and an
 * equal-size empty placeholder takes its place; streamed chunks meanwhile
 * update stored input only. These tests pin that contract without real
 * observers (heights are fed in the way IntersectionObserver would).
 */
import { parseHTML } from "linkedom";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// codeHighlight.ts imports the highlight.js theme stylesheet, which only Vite
// can resolve — no-op the extension so the module loads under node:test.
(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Node: dom.Node,
  SVGElement: dom.SVGElement,
});

type CardModule = typeof import("./ToolInvocationCardView.js");
type VirtualModule = typeof import("./virtualToolCard.js");
type PreviewModule = typeof import("./streamingWritePreview.js");
let createToolInvocationCard: CardModule["createToolInvocationCard"];
let suspendVirtualToolCard: VirtualModule["suspendVirtualToolCard"];
let resumeVirtualToolCard: VirtualModule["resumeVirtualToolCard"];
let disposeVirtualToolCard: VirtualModule["disposeVirtualToolCard"];
let virtualToolCardIsSuspended: VirtualModule["virtualToolCardIsSuspended"];
let setVirtualToolCardOpen: VirtualModule["setVirtualToolCardOpen"];
let transferVirtualToolCardState: VirtualModule["transferVirtualToolCardState"];
let updateStreamingWritePreviewCard: PreviewModule["updateStreamingWritePreviewCard"];

before(async () => {
  createToolInvocationCard = (await import("./ToolInvocationCardView.js"))
    .createToolInvocationCard;
  ({
    suspendVirtualToolCard,
    resumeVirtualToolCard,
    disposeVirtualToolCard,
    virtualToolCardIsSuspended,
    setVirtualToolCardOpen,
    transferVirtualToolCardState,
  } = await import("./virtualToolCard.js"));
  updateStreamingWritePreviewCard = (
    await import("./streamingWritePreview.js")
  ).updateStreamingWritePreviewCard;
});

function writeSlot(content = "const a = 1;"): HTMLElement {
  return createToolInvocationCard({
    id: "call-1",
    name: "write_file",
    status: "pending",
    arguments: { path: "/tmp/a.ts", content },
    argumentsRaw: JSON.stringify({ path: "/tmp/a.ts", content }),
    previewContent: content,
  });
}

describe("virtualized tool cards", () => {
  it("wraps write cards in a slot that owns the identity", () => {
    const slot = writeSlot();
    const card = slot.firstElementChild as HTMLElement;
    assert.ok(slot.classList.contains("conversation-tool-slot"));
    assert.ok(card.classList.contains("content-card-tool-invocation"));
    assert.equal(slot.dataset.toolCallId, "call-1");
    assert.equal(card.hasAttribute("data-tool-call-id"), false);
    assert.equal(slot.dataset.toolStreaming, "1");
  });

  it("leaves non-write tools unwrapped", () => {
    const card = createToolInvocationCard({
      id: "call-2",
      name: "read_file",
      status: "done",
      arguments: { path: "/tmp/b.ts" },
      argumentsRaw: "{}",
      result: { returnCode: 0, content: [] },
    });
    assert.equal(card.classList.contains("conversation-tool-slot"), false);
    const icon = card.querySelector(".content-card-tool-icon")!;
    assert.equal(icon.getAttribute("fill"), "none");
    assert.equal(icon.getAttribute("stroke"), "currentColor");
    assert.equal(icon.hasAttribute("data-functional-icon"), false);
  });

  it("suspend destroys the card DOM and keeps an equal-size placeholder", () => {
    const slot = writeSlot();
    assert.ok(slot.querySelector(".tool-file-lines"));
    assert.equal(suspendVirtualToolCard(slot, 321), true);
    assert.equal(virtualToolCardIsSuspended(slot), true);
    assert.equal(slot.childElementCount, 0, "card DOM must be destroyed");
    assert.equal(slot.querySelector(".tool-file-lines"), null);
    assert.equal(slot.dataset.toolPlaceholder, "1");
    assert.equal(slot.style.height, "321px");
    assert.equal(slot.getAttribute("aria-hidden"), "true");
  });

  it("suspend refuses to cache a zero height (detached ancestor)", () => {
    const slot = writeSlot();
    assert.equal(suspendVirtualToolCard(slot, 0), false);
    assert.equal(virtualToolCardIsSuspended(slot), false);
    assert.ok(slot.querySelector(".tool-file-lines"), "card stays alive");
  });

  it("suspended slots absorb streamed chunks without creating DOM", () => {
    const slot = writeSlot();
    suspendVirtualToolCard(slot, 200);
    const patched = updateStreamingWritePreviewCard(slot, {
      name: "write_file",
      arguments: { path: "/tmp/a.ts", content: "const a = 1;\nconst b = 2;" },
      argumentsRaw: JSON.stringify({
        path: "/tmp/a.ts",
        content: "const a = 1;\nconst b = 2;",
      }),
      previewContent: "const a = 1;\nconst b = 2;",
    });
    assert.equal(patched, true);
    assert.equal(slot.childElementCount, 0, "no DOM while offscreen");
  });

  it("resume rebuilds from the latest stream data and clears the placeholder", () => {
    const slot = writeSlot();
    suspendVirtualToolCard(slot, 200);
    updateStreamingWritePreviewCard(slot, {
      name: "write_file",
      arguments: { path: "/tmp/a.ts", content: "const a = 1;\nconst b = 2;" },
      argumentsRaw: JSON.stringify({
        path: "/tmp/a.ts",
        content: "const a = 1;\nconst b = 2;",
      }),
      previewContent: "const a = 1;\nconst b = 2;",
    });
    assert.equal(resumeVirtualToolCard(slot), true);
    assert.equal(virtualToolCardIsSuspended(slot), false);
    assert.equal(slot.hasAttribute("data-tool-placeholder"), false);
    assert.equal(slot.style.height, "");
    const card = slot.firstElementChild as HTMLElement;
    assert.ok(card.classList.contains("content-card-tool-invocation"));
    assert.match(card.textContent ?? "", /const b = 2;/);
    assert.equal(slot.dataset.toolCallId, "call-1");
  });

  it("open state survives suspend and resume", () => {
    const slot = writeSlot();
    setVirtualToolCardOpen(slot, false);
    suspendVirtualToolCard(slot, 150);
    resumeVirtualToolCard(slot);
    const card = slot.firstElementChild as HTMLDetailsElement;
    assert.equal(card.tagName, "DETAILS");
    assert.equal(card.open, false);
  });

  it("finished-card swap carries user state across slots", () => {
    const streaming = writeSlot();
    setVirtualToolCardOpen(streaming, false);
    suspendVirtualToolCard(streaming, 150);

    const finished = createToolInvocationCard({
      id: "call-1",
      name: "write_file",
      status: "done",
      arguments: { path: "/tmp/a.ts", content: "const a = 1;" },
      argumentsRaw: "{}",
      result: { returnCode: 0, content: [] },
    });
    transferVirtualToolCardState(streaming, finished);
    streaming.replaceWith(finished);

    // Offscreen finish stays a placeholder; no DOM resurrection.
    assert.equal(virtualToolCardIsSuspended(finished), true);
    assert.equal(finished.childElementCount, 0);
    assert.equal(finished.style.height, "150px");

    resumeVirtualToolCard(finished);
    const card = finished.firstElementChild as HTMLDetailsElement;
    assert.equal(card.open, false, "user collapse carried across the swap");
  });

  it("dispose is terminal and idempotent", () => {
    const slot = writeSlot();
    disposeVirtualToolCard(slot);
    assert.equal(slot.childElementCount, 0);
    assert.equal(suspendVirtualToolCard(slot, 100), false);
    assert.equal(resumeVirtualToolCard(slot), false);
    disposeVirtualToolCard(slot);
  });
});
