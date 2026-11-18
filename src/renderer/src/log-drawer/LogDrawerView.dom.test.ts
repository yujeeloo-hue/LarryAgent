import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  if (request.includes("?url")) return request.slice(0, request.indexOf("?url"));
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  Event: dom.window.Event,
  requestAnimationFrame: () => 0,
});

let LogDrawerView: typeof import("./LogDrawerView.js").LogDrawerView;
before(async () => {
  ({ LogDrawerView } = await import("./LogDrawerView.js"));
});

test("toolbar is a single row: metrics first, actions last, no close button", () => {
  const view = new LogDrawerView();
  const toolbars = view.root.querySelectorAll(".log-drawer-toolbar");
  assert.equal(toolbars.length, 1, "one toolbar row");
  assert.equal(view.root.querySelectorAll(".log-drawer-filters").length, 0);

  const children = Array.from(toolbars[0]!.children);
  assert.ok(children[0]!.classList.contains("log-drawer-metrics"), "metrics lead");
  assert.ok(
    children.at(-1)!.classList.contains("log-drawer-actions"),
    "actions trail",
  );
  assert.equal(
    view.root.querySelector('[aria-label="Close"]'),
    null,
    "the drawer has no close of its own",
  );
});

test("actions are icon-only buttons that keep an accessible name", () => {
  const view = new LogDrawerView();
  for (const [button, label] of [
    [view.dumpMemoryButton, "Save memory snapshot"],
    [view.saveButton, "Save logs"],
    [view.openFolderButton, "Open log folder"],
    [view.clearButton, "Clear logs"],
    [view.fullRequestButton, "Full request"],
  ] as const) {
    assert.equal(button.textContent, "", `${label} renders no text`);
    assert.equal(button.getAttribute("aria-label"), label);
    assert.ok(button.title.length > 0, `${label} keeps a tooltip`);
    assert.ok(button.querySelector("svg"), `${label} carries a glyph`);
    assert.ok(button.classList.contains("log-drawer-icon-btn"));
  }
});

test("action glyphs are stock Lucide, matching the other Detail panes", () => {
  const view = new LogDrawerView();
  for (const [button, label] of [
    [view.dumpMemoryButton, "Save memory snapshot"],
    [view.saveButton, "Save"],
    [view.openFolderButton, "Folder"],
    [view.clearButton, "Clear"],
    [view.fullRequestButton, "Full request"],
  ] as const) {
    const svg = button.querySelector("svg");
    assert.ok(svg, `${label} carries a glyph`);
    assert.equal(
      svg.getAttribute("data-functional-icon"),
      null,
      `${label} stays stock Lucide`,
    );
    assert.equal(svg.getAttribute("fill"), "none");
    assert.equal(svg.getAttribute("stroke"), "currentColor");
  }
});

test("memory dump button uses the stock Lucide microchip glyph", async () => {
  const { createLucideIcon, Microchip } = await import("../ui/originalIcons.js");
  const view = new LogDrawerView();
  const glyph = view.dumpMemoryButton.querySelector("svg");
  assert.ok(glyph, "dump button carries a glyph");
  assert.equal(
    glyph.outerHTML,
    createLucideIcon(Microchip, { size: 14 }).outerHTML,
    "glyph matches Microchip, not the old memory-stick icon",
  );
});

test("level chips start enabled and toggle their pressed state", () => {
  const view = new LogDrawerView();
  const chips = Array.from(
    view.root.querySelectorAll<HTMLButtonElement>(".log-drawer-level-toggle"),
  );
  assert.deepEqual(
    chips.map((chip) => chip.dataset.level),
    ["debug", "info", "warn", "error"],
  );
  assert.ok(chips.every((chip) => chip.getAttribute("aria-pressed") === "true"));

  view.setLevelEnabled("warn", false);
  assert.equal(view.levelButtons.warn.getAttribute("aria-pressed"), "false");
  assert.equal(view.levelButtons.warn.classList.contains("is-on"), false);
  assert.equal(view.levelButtons.error.getAttribute("aria-pressed"), "true");
});

test("source filter is the shared app dropdown, not a native select", () => {
  const view = new LogDrawerView();
  assert.equal(view.root.querySelector("select"), null, "no native select");
  const root = view.root.querySelector(".log-drawer-source-filter");
  assert.ok(root, "dropdown root sits in the toolbar");
  assert.deepEqual(
    Array.from(root!.querySelectorAll(".app-dropdown-option-label")).map(
      (node) => node.textContent,
    ),
    ["All", "Main", "Renderer"],
  );
  assert.equal(view.getSourceFilter(), "all");

  view.sourceDropdown.value = "renderer";
  assert.equal(view.getSourceFilter(), "renderer");
  assert.equal(
    root!.querySelector(".app-dropdown-btn")!.getAttribute("aria-expanded"),
    "false",
  );
});
