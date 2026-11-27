import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

test("every pane-head action glyph draws at one size", async () => {
  const { PANE_HEAD_ICON_SIZE } = await import("./paneHeadIcons.js");
  const { DebugConsoleView } = await import("./DebugConsoleView.js");
  const { FindUsagesView } = await import("./FindUsagesView.js");
  const { TerminalPaneView } = await import("./TerminalPaneView.js");
  const { BuildProblemsView } = await import("./BuildProblemsView.js");

  assert.equal(PANE_HEAD_ICON_SIZE, 14);

  const consoleView = new DebugConsoleView();
  const references = new FindUsagesView();
  const terminal = new TerminalPaneView();
  const problems = new BuildProblemsView();
  const glyphs: Array<[string, SVGElement | null]> = [
    ["debug console copy", consoleView.copyButton.querySelector("svg")],
    ["debug console clear", consoleView.clearButton.querySelector("svg")],
    [
      "references clear",
      references.root.querySelector<SVGElement>(".devmode-references-clear svg"),
    ],
    ["terminal clear", terminal.clearButton.querySelector("svg")],
    [
      "build problems clear",
      problems.root.querySelector<SVGElement>(".devmode-build-problems-clear svg"),
    ],
  ];

  for (const [label, svg] of glyphs) {
    assert.ok(svg, `${label} lost its glyph`);
    assert.equal(svg.getAttribute("width"), String(PANE_HEAD_ICON_SIZE), label);
    assert.equal(svg.getAttribute("height"), String(PANE_HEAD_ICON_SIZE), label);
    assert.equal(svg.getAttribute("stroke-width"), "1.75", label);
    assert.equal(svg.getAttribute("data-functional-icon"), null, label);
  }

  const brooms = glyphs
    .filter(([label]) => label.endsWith(" clear"))
    .map(([, svg]) => svg!.outerHTML);
  assert.equal(new Set(brooms).size, 1, `brooms differ: ${brooms.join("\n")}`);
});
