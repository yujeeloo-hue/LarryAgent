import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { BuildProblemsView } from "./BuildProblemsView.js";
import { parseBuildDiagnostic } from "./buildDiagnostics.js";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, HTMLElement: dom.HTMLElement });

test("filled icons, counts, error-first order and precise navigation share the compiler records", () => {
  const view = new BuildProblemsView();
  const warning = parseBuildDiagnostic("Actor.cpp(8,3): warning C4100: unused")!;
  const error = parseBuildDiagnostic("Source/Main.cpp(42,7): error C2065: missing name")!;
  let opened: unknown;
  view.onOpen = item => { opened = item; };
  view.append([warning]); view.append([error, warning]);
  assert.equal(view.root.querySelectorAll(".devmode-build-problem").length, 2);
  const clearGlyph = view.root.querySelector(".devmode-build-problems-clear svg");
  assert.equal(clearGlyph?.getAttribute("data-functional-icon"), null);
  assert.match(clearGlyph?.innerHTML ?? "", /m16 22-1-4/);
  assert.equal(clearGlyph?.getAttribute("stroke"), "currentColor");
  assert.equal(view.root.querySelector('[aria-label="1 errors"]')?.textContent, "1");
  assert.equal(view.root.querySelector('[aria-label="1 warnings"]')?.textContent, "1");
  const row = view.root.querySelector<HTMLButtonElement>(".devmode-build-problem")!;
  assert.match(row.textContent!, /missing name/); row.click(); assert.deepEqual(opened, error);
  assert.equal(row.getAttribute("aria-current"), "location");
  const clearNode = view.root.querySelector(".devmode-build-problems-clear svg");
  for (const icon of view.root.querySelectorAll("svg")) {
    if (icon === clearNode) continue;
    assert.equal(icon.getAttribute("fill"), "currentColor");
    assert.equal(icon.getAttribute("stroke"), "none");
  }
  view.append([parseBuildDiagnostic("Actor.cpp(9): warning C4100: another")!]);
  assert.equal(view.root.querySelector('[aria-current="location"]'), row, "stream updates preserve the selected DOM node");
  view.root.querySelectorAll<HTMLButtonElement>(".devmode-build-problem")[1]!.click();
  assert.equal(row.hasAttribute("aria-current"), false);
});

test("no source location is represented honestly, compiler markup is text, and clear resets counts", () => {
  const view = new BuildProblemsView();
  view.append([parseBuildDiagnostic("LINK : fatal error LNK1104: <img src=x onerror=alert(1)>")!]);
  assert.equal(view.root.querySelector(".devmode-build-problem")?.tagName, "DIV");
  assert.equal(view.root.querySelectorAll("button").length, 1);
  assert.equal(view.root.querySelector("img"), null);
  assert.match(view.root.textContent!, /<img/);
  view.clear(); assert.equal(view.root.querySelectorAll(".devmode-build-problem").length, 0);
  assert.equal(view.root.querySelector('[aria-label="0 errors"]')?.textContent, "0");
});
