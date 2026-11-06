/**
 * DOM tests: incremental lined-file rendering used by streaming write /
 * patch previews. The point of `updateLinedFileView` is that already rendered
 * rows keep their DOM nodes, so the scroll container survives every chunk.
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
  Node: dom.Node,
});

type LinedFileViewModule = typeof import("./LinedFileView.js");
let createLinedFileView: LinedFileViewModule["createLinedFileView"];
let updateLinedFileView: LinedFileViewModule["updateLinedFileView"];

before(async () => {
  const mod = await import("./LinedFileView.js");
  createLinedFileView = mod.createLinedFileView;
  updateLinedFileView = mod.updateLinedFileView;
});

function rowTexts(wrap: HTMLElement): string[] {
  return [...wrap.children].map((row) => row.textContent ?? "");
}

function gutters(wrap: HTMLElement): string[] {
  return [...wrap.querySelectorAll(".tool-file-gutter")].map(
    (gutter) => gutter.textContent ?? "",
  );
}

describe("updateLinedFileView", () => {
  it("appends new lines and keeps the earlier rows' DOM nodes", () => {
    const wrap = createLinedFileView("alpha\nbravo", { pathOrName: "a.txt" });
    const firstRow = wrap.children[0];

    updateLinedFileView(wrap, "alpha\nbravo\ncharlie", {
      pathOrName: "a.txt",
    });

    assert.equal(wrap.childElementCount, 3);
    assert.equal(wrap.children[0], firstRow);
    assert.deepEqual(
      rowTexts(wrap),
      rowTexts(createLinedFileView("alpha\nbravo\ncharlie", {
        pathOrName: "a.txt",
      })),
    );
  });

  it("re-renders the last line while it is still growing", () => {
    const wrap = createLinedFileView("alpha\nbra", { pathOrName: "a.txt" });
    updateLinedFileView(wrap, "alpha\nbravo", { pathOrName: "a.txt" });

    assert.equal(wrap.childElementCount, 2);
    assert.match(wrap.children[1]!.textContent ?? "", /bravo$/);
  });

  it("re-pads gutters when the line count crosses a digit boundary", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `line${i}`).join("\n");
    const wrap = createLinedFileView(nine, { pathOrName: "a.txt" });
    assert.deepEqual(gutters(wrap)[0], "1");

    updateLinedFileView(wrap, `${nine}\nline9\nline10`, {
      pathOrName: "a.txt",
    });
    assert.equal(wrap.childElementCount, 11);
    assert.deepEqual(gutters(wrap)[0], " 1");
    assert.deepEqual(gutters(wrap)[10], "11");
  });

  it("falls back to a full re-render when the text is not an extension", () => {
    const wrap = createLinedFileView("alpha\nbravo", { pathOrName: "a.txt" });
    updateLinedFileView(wrap, "zulu\nyankee", { pathOrName: "a.txt" });

    assert.equal(wrap.childElementCount, 2);
    assert.deepEqual(
      rowTexts(wrap),
      rowTexts(createLinedFileView("zulu\nyankee", { pathOrName: "a.txt" })),
    );
  });

  it("grows out of the empty placeholder", () => {
    const wrap = createLinedFileView("", { pathOrName: "a.txt" });
    assert.equal(wrap.textContent, "(empty)");

    updateLinedFileView(wrap, "alpha", { pathOrName: "a.txt" });
    assert.equal(wrap.childElementCount, 1);
    assert.match(wrap.textContent ?? "", /alpha$/);
  });
});
