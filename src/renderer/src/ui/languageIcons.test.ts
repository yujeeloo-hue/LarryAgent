import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

test("lua files get the same LU badge as the other languages", async () => {
  const { createLanguageIcon } = await import("./languageIcons.js");
  const wrap = createLanguageIcon("lua");
  assert.equal(wrap.className, "devmode-tab-icon");
  assert.equal(wrap.getAttribute("data-lang"), "lua");

  const svg = wrap.querySelector("svg");
  assert.ok(svg, "badge renders the shared 14x14 svg");
  assert.equal(svg.getAttribute("viewBox"), "0 0 14 14");
  assert.equal(svg.getAttribute("width"), "14");
  assert.equal(svg.getAttribute("height"), "14");

  const rect = svg.querySelector("rect");
  assert.ok(rect, "badge has the rounded colour block");
  assert.equal(rect.getAttribute("width"), "14");
  assert.equal(rect.getAttribute("height"), "14");
  assert.equal(rect.getAttribute("rx"), "3.5");
  assert.equal(rect.getAttribute("fill"), "var(--libg, currentColor)");

  const text = svg.querySelector("text");
  assert.ok(text, "badge has the language glyph");
  assert.equal(text.textContent, "LU");
  assert.equal(text.getAttribute("font-size"), "6.5");
  assert.equal(text.getAttribute("font-weight"), "700");
  assert.equal(text.getAttribute("fill"), "var(--lifg, #ffffff)");
});

test("lua badge colour is defined in both icon surfaces", () => {
  const surfaces = [
    ["dev mode", "../devmode/devmode.css", '.devmode-tab-icon[data-lang="lua"]'],
    ["git panel", "../screens/conversation/gitPanel/gitPanel.css", '.git-panel-lang[data-lang="lua"]'],
  ] as const;
  for (const [label, path, selector] of surfaces) {
    const css = readFileSync(new URL(path, import.meta.url), "utf8");
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      css,
      new RegExp(`${escaped}\\s*\\{[^}]*--libg:\\s*#2b4ba3;[^}]*--lifg:\\s*#ffffff;`),
      `${label} defines the approved lua colours`,
    );
  }
});
