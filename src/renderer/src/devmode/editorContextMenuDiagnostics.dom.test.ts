import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import test from "node:test";
import type { editor } from "monaco-editor";
import {
  contextMenuVisible,
  trackEditorContextMenu,
} from "./editorContextMenuDiagnostics.js";

const dom = parseHTML(`<!doctype html><html><body><div id="host"></div></body></html>`);

let pageHasFocus = true;
const logged: Array<Record<string, unknown>> = [];

Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
});
Object.assign(dom.window, { setTimeout, clearTimeout, setInterval, clearInterval });
Object.defineProperty(dom.document, "hasFocus", {
  configurable: true,
  value: () => pageHasFocus,
});
Object.defineProperty(dom.window, "jellybot", {
  configurable: true,
  value: { logEditorContextMenu: (fields: Record<string, unknown>) => logged.push(fields) },
});

const MouseTargetType = {
  TEXTAREA: 1,
  GUTTER_GLYPH_MARGIN: 2,
  CONTENT_TEXT: 6,
  CONTENT_EMPTY: 7,
  1: "TEXTAREA",
  2: "GUTTER_GLYPH_MARGIN",
  6: "CONTENT_TEXT",
  7: "CONTENT_EMPTY",
};
const monaco = {
  editor: { MouseTargetType, EditorOption: { contextmenu: 30 } },
} as unknown as Parameters<typeof trackEditorContextMenu>[0];

type ContextMenuListener = (event: unknown) => void;

function fakeEditor(): { target: editor.ICodeEditor; fire: (type: number) => void } {
  let listener: ContextMenuListener | null = null;
  const target = {
    onContextMenu: (callback: ContextMenuListener) => {
      listener = callback;
      return { dispose: () => { listener = null; } };
    },
    getOption: () => true,
    getModel: () => ({}),
  } as unknown as editor.ICodeEditor;
  const fire = (type: number): void => {
    listener?.({
      target: { type, detail: { injectedText: null } },
      event: { browserEvent: { defaultPrevented: true } },
    });
  };
  return { target, fire };
}

function showMenu(): HTMLElement {
  const view = dom.document.createElement("div");
  view.className = "context-view monaco-component";
  view.append(dom.document.createElement("div"));
  dom.document.getElementById("host")!.append(view);
  return view as unknown as HTMLElement;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("contextMenuVisible ignores hidden and empty context views", () => {
  const host = dom.document.getElementById("host")!;
  host.replaceChildren();
  assert.equal(contextMenuVisible(dom.document), false);
  const view = showMenu();
  assert.equal(contextMenuVisible(dom.document), true);
  view.style.display = "none";
  assert.equal(contextMenuVisible(dom.document), false);
  host.replaceChildren();
});

test("A menu that opens and stays open is logged as shown with no early close", async () => {
  logged.length = 0;
  pageHasFocus = true;
  const { target, fire } = fakeEditor();
  const tracker = trackEditorContextMenu(monaco, target, "editor");
  showMenu();
  fire(MouseTargetType.CONTENT_TEXT);
  await settle(450);
  tracker.dispose();
  dom.document.getElementById("host")!.replaceChildren();

  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.surface, "editor");
  assert.equal(logged[0]!.targetType, "CONTENT_TEXT");
  assert.equal(logged[0]!.menuExpected, true);
  assert.equal(logged[0]!.menuShown, true);
  assert.equal(logged[0]!.menuOpenAfterSettle, true);
  assert.equal(logged[0]!.menuHiddenAfterMs, null);
  assert.equal(logged[0]!.documentFocused, true);
});

test("A menu that closes right after opening records how fast it closed and the page focus state", async () => {
  logged.length = 0;
  pageHasFocus = false;
  const { target, fire } = fakeEditor();
  const tracker = trackEditorContextMenu(monaco, target, "editor");
  const view = showMenu();
  fire(MouseTargetType.CONTENT_TEXT);
  setTimeout(() => { view.style.display = "none"; }, 50);
  await settle(450);
  tracker.dispose();
  dom.document.getElementById("host")!.replaceChildren();

  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.menuShown, true);
  assert.equal(logged[0]!.menuOpenAfterSettle, false);
  assert.equal(typeof logged[0]!.menuHiddenAfterMs, "number");
  assert.equal(logged[0]!.documentFocused, false);
});

test("A glyph-margin right-click is logged but not marked as expecting a menu", async () => {
  logged.length = 0;
  pageHasFocus = true;
  const { target, fire } = fakeEditor();
  const tracker = trackEditorContextMenu(monaco, target, "editor");
  fire(MouseTargetType.GUTTER_GLYPH_MARGIN);
  await settle(450);
  tracker.dispose();

  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.targetType, "GUTTER_GLYPH_MARGIN");
  assert.equal(logged[0]!.menuExpected, false);
  assert.equal(logged[0]!.menuShown, false);
});

test("Disposing the tracker before the settle delay drops the pending log", async () => {
  logged.length = 0;
  const { target, fire } = fakeEditor();
  const tracker = trackEditorContextMenu(monaco, target, "editor");
  fire(MouseTargetType.CONTENT_TEXT);
  tracker.dispose();
  await settle(450);

  assert.equal(logged.length, 0);
});
