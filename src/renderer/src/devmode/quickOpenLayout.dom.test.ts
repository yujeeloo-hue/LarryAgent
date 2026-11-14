import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { QuickOpenController } from "./QuickOpenController.js";
import { resetClangdAvailabilityCache } from "./clangdFeatures.js";
import { QuickOpenSearchIndex } from "./quickOpenIndex.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node });
const storage = new Map<string, string>();
Object.assign(window, { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
const settle = () => new Promise(resolve => setTimeout(resolve, 240));
const root = "/workspace/Atlas";
const engine = "/tools/Unreal/Engine";
type SymbolEntry = { name: string; path: string; line: number; symbolKind: string };

function harness() {
  storage.clear(); document.body.replaceChildren(); resetClangdAvailabilityCache();
  const opened: Array<{ path: string; line: number | undefined }> = [];
  const symbols: SymbolEntry[] = [
    ...Array.from({ length: 35 }, (_, i) => ({ name: `WidgetMethod${i}`, path: `${root}/Source/Widget.cpp`, line: i + 10, symbolKind: "function" })),
    { name: "Widget", path: `${root}/Source/Widget.h`, line: 7, symbolKind: "class" },
    { name: "WidgetEngine", path: `${engine}/Source/WidgetEngine.h`, line: 31, symbolKind: "struct" },
  ];
  let chunk: ((event: unknown) => void) | undefined;
  Object.assign(window, { jellybot: {
    getDevModeEngineRoot: async () => engine,
    searchDevModeFiles: async () => ({ ok: true, files: [{ path: `${root}/Source/Widget.h`, rel: "Source/Widget.h" }] }),
    readTextFile: async () => ({ ok: true, content: "" }),
    startDevModeFileIndex: async (_root: string, requestId: number) => {
      queueMicrotask(() => chunk?.({ requestId, files: [{ path: `${engine}/Source/WidgetEngine.h`, rel: "Engine/Source/WidgetEngine.h" }], done: true, truncated: false }));
      return { ok: true };
    },
    onDevModeIndexChunk: (handler: typeof chunk) => { chunk = handler; return () => { chunk = undefined; }; },
    cancelDevModeFileIndex: async () => {},
    clangdStatus: async () => ({ ok: true }),
    clangdWorkspaceSymbols: async (_root: string, query: string) => ({ ok: true, symbols: symbols.filter(s => s.name.toLowerCase().includes(query.toLowerCase())) }),
    clangdReferences: async () => {}, clangdDefinition: async () => {}, clangdCancelQuery: async () => {}, clangdHover: async () => {}, clangdCompletion: async () => {}, clangdSignatureHelp: async () => {},
  } });
  const controller = new QuickOpenController({ getWorkspaceRoot: () => root, getRecentFiles: () => [`${root}/Source/Recent.cpp`], openFile: (path, line) => opened.push({ path, line }) });
  controller.mount(document.body); controller.open("Widget");
  const input = document.querySelector<HTMLInputElement>(".devmode-quickopen-input")!;
  return { controller, input, opened, rows: () => [...document.querySelectorAll<HTMLElement>(".devmode-quickopen-item")], tab: async (category: string) => { (document.querySelector(`[data-category="${category}"]`) as HTMLButtonElement).click(); await settle(); } };
}

test("Types and Symbols filter before the result cap, and symbols open their declaration line", async () => {
  const h = harness();
  try {
    await settle(); await h.tab("Types");
    assert.deepEqual(h.rows().map(row => row.querySelector(".devmode-quickopen-name")?.textContent), ["Widget", "WidgetEngine"]);
    assert.equal(document.querySelector(".devmode-quickopen-tabs [aria-selected=true]")?.textContent, "Types");
    assert.ok(h.rows()[0]?.querySelector("mark"));
    await h.tab("Symbols");
    assert.ok(h.rows().length > 0);
    assert.ok(h.rows().every(row => row.querySelector(".devmode-quickopen-name")?.textContent?.startsWith("WidgetMethod")));
    h.input.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Enter" }));
    assert.equal(h.opened[0]?.path, `${root}/Source/Widget.cpp`); assert.equal(typeof h.opened[0]?.line, "number");
  } finally { h.controller.destroy(); }
});

test("Include Engine excludes external file AND type results; unrelated workspaces keep dynamic labels", async () => {
  const h = harness();
  try {
    await settle(); await new Promise(resolve => setTimeout(resolve, 450));
    const checkbox = document.querySelector<HTMLInputElement>(".devmode-quickopen-scope input")!;
    assert.equal(document.querySelector<HTMLLabelElement>(".devmode-quickopen-scope")?.hidden, false);
    checkbox.checked = false; checkbox.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.ok(h.rows().every(row => !row.title.startsWith(engine)));
    assert.ok(h.rows().every(row => row.querySelector(".devmode-quickopen-project")?.textContent === "Atlas"));
    await h.tab("Types"); assert.equal(h.rows().length, 1);
    checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(h.rows().length, 2);
  } finally { h.controller.destroy(); }
});

test("recent files, empty state, accessible selection and individual keycaps are wired", async () => {
  const h = harness();
  try {
    await settle(); await h.tab("Files");
    h.rows()[0]!.click(); assert.equal(h.controller.isOpen, false);
    h.controller.open(); await settle();
    assert.equal(document.querySelector(".devmode-quickopen-label")?.textContent, "Recent Files");
    assert.ok(h.rows().some(row => row.title === `${root}/Source/Widget.h`));
    assert.deepEqual([...document.querySelectorAll(".devmode-quickopen-keys kbd")].map(key => key.textContent), ["↑", "↓", "Enter", "Esc"]);
    h.input.value = "no-such-file"; h.input.dispatchEvent(new dom.window.Event("input")); await settle();
    assert.equal(document.querySelector(".devmode-quickopen-hint")?.textContent, "No results found");
    assert.equal(h.input.hasAttribute("aria-activedescendant"), false);
  } finally { h.controller.destroy(); }
});

test("project-only index queries fill the limit instead of filtering out already-ranked engine hits", () => {
  const index = new QuickOpenSearchIndex();
  index.setTier("project", [{ path: "/project/SomeWidget.h", rel: "Source/SomeWidget.h" }]);
  index.setTier("engine", [{ path: "/engine/Widget.h", rel: "Engine/Widget.h" }]);
  assert.equal(index.query("Widget", 1, false, true).files[0]?.path, "/engine/Widget.h");
  assert.equal(index.query("Widget", 1, false, false).files[0]?.path, "/project/SomeWidget.h");
});
