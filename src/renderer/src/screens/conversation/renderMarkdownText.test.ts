/**
 * DOM tests: incremental streaming Markdown paints. Blocks that did not change
 * must keep their DOM nodes so repaints stop recreating the scroll containers
 * inside code fences.
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

type RenderModule = typeof import("./renderMarkdownText.js");
let renderMarkdownText: RenderModule["renderMarkdownText"];

before(async () => {
  renderMarkdownText = (await import("./renderMarkdownText.js"))
    .renderMarkdownText;
});

function container(): HTMLElement {
  return document.createElement("div");
}

describe("renderMarkdownText (streaming)", () => {
  it("keeps unchanged blocks and only redraws the tail", () => {
    const el = container();
    renderMarkdownText("First paragraph.\n\nSecond para", el, {
      streaming: true,
    });
    assert.equal(el.childElementCount, 2);
    const first = el.children[0];
    const second = el.children[1];

    renderMarkdownText("First paragraph.\n\nSecond paragraph.", el, {
      streaming: true,
    });

    assert.equal(el.childElementCount, 2);
    assert.equal(el.children[0], first);
    assert.notEqual(el.children[1], second);
    assert.match(el.textContent ?? "", /Second paragraph\./);
  });

  it("appends a new block without touching earlier ones", () => {
    const el = container();
    renderMarkdownText("Alpha.\n\nBravo.", el, { streaming: true });
    const [first, second] = [el.children[0], el.children[1]];

    renderMarkdownText("Alpha.\n\nBravo.\n\nCharlie.", el, { streaming: true });

    assert.equal(el.childElementCount, 3);
    assert.equal(el.children[0], first);
    assert.equal(el.children[1], second);
  });

  it("keeps a closed code fence stable while prose grows after it", () => {
    const el = container();
    const base = "```ts\nconst a = 1;\n```\n\nAfter";
    renderMarkdownText(base, el, { streaming: true });
    const fence = el.children[0];

    renderMarkdownText(`${base} the fence.`, el, { streaming: true });

    assert.equal(el.children[0], fence);
  });

  it("re-renders everything on a final non-streaming paint", () => {
    const el = container();
    renderMarkdownText("Alpha.", el, { streaming: true });
    const first = el.children[0];

    renderMarkdownText("Alpha.", el);

    assert.equal(el.childElementCount, 1);
    assert.notEqual(el.children[0], first);
  });
});
