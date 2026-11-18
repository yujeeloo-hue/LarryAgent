import { parseHTML } from "linkedom";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

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
type PreviewModule = typeof import("./streamingWritePreview.js");
let createToolInvocationCard: CardModule["createToolInvocationCard"];
let updateStreamingWritePreviewCard: PreviewModule["updateStreamingWritePreviewCard"];

before(async () => {
  createToolInvocationCard = (await import("./ToolInvocationCardView.js"))
    .createToolInvocationCard;
  updateStreamingWritePreviewCard = (
    await import("./streamingWritePreview.js")
  ).updateStreamingWritePreviewCard;
});

function writeFileCard(path: string, content: string): HTMLElement {
  return createToolInvocationCard({
    id: "call-1",
    name: "write_file",
    status: "pending",
    arguments: { path, content },
    argumentsRaw: JSON.stringify({ path, content }),
    previewContent: content,
  });
}

describe("updateStreamingWritePreviewCard", () => {
  it("keeps the scroll container while the preview grows", () => {
    const card = writeFileCard("/tmp/a.ts", "const a = 1;");
    const lines = card.querySelector(".tool-file-lines");
    assert.ok(lines);

    const patched = updateStreamingWritePreviewCard(card, {
      name: "write_file",
      arguments: { path: "/tmp/a.ts", content: "const a = 1;\nconst b = 2;" },
      argumentsRaw: JSON.stringify({
        path: "/tmp/a.ts",
        content: "const a = 1;\nconst b = 2;",
      }),
      previewContent: "const a = 1;\nconst b = 2;",
    });

    assert.equal(patched, true);
    assert.equal(card.querySelector(".tool-file-lines"), lines);
    assert.equal(lines!.childElementCount, 2);
    assert.match(card.textContent ?? "", /const b = 2;/);
  });

  it("refuses to patch when the tool name changes", () => {
    const card = writeFileCard("/tmp/a.ts", "const a = 1;");
    const patched = updateStreamingWritePreviewCard(card, {
      name: "patch",
      arguments: { patch: "*** Update File: /tmp/a.ts\n" },
      argumentsRaw: JSON.stringify({ patch: "*** Update File: /tmp/a.ts\n" }),
      previewContent: "*** Update File: /tmp/a.ts\n",
    });
    assert.equal(patched, false);
  });

  it("refuses to patch when the preview flips to markdown", () => {
    const card = writeFileCard("/tmp/a.ts", "const a = 1;");
    const patched = updateStreamingWritePreviewCard(card, {
      name: "write_file",
      arguments: { path: "/tmp/notes.md", content: "# Title" },
      argumentsRaw: JSON.stringify({ path: "/tmp/notes.md", content: "# Title" }),
      previewContent: "# Title",
    });
    assert.equal(patched, false);
  });

  it("tracks the path arriving mid-stream in the summary hint", () => {
    const card = writeFileCard("", "const a = 1;");
    updateStreamingWritePreviewCard(card, {
      name: "write_file",
      arguments: { path: "/tmp/later.ts", content: "const a = 1;" },
      argumentsRaw: JSON.stringify({
        path: "/tmp/later.ts",
        content: "const a = 1;",
      }),
      previewContent: "const a = 1;",
    });
    const hint = card.querySelector(".content-card-tool-result-hint");
    assert.ok(hint);
    assert.match(hint!.textContent ?? "", /later\.ts/);
  });
});
