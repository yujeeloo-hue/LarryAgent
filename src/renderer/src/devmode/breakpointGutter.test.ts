import assert from "node:assert/strict";
import test from "node:test";
import type * as MonacoTypes from "monaco-editor";
import type { MonacoApi } from "./monacoSetup.js";
import { BreakpointGutterController } from "./BreakpointGutterController.js";

function harness() {
  const listeners = new Map<string, (...args: any[]) => void>();
  let decorations: MonacoTypes.editor.IModelDeltaDecoration[] = [];
  let changes = 0;
  let enabled = true;
  let hasModel = true;
  const occupied = new Set<number>();
  const collection = {
    set(next: MonacoTypes.editor.IModelDeltaDecoration[]) {
      decorations = next;
      changes++;
    },
    clear() { decorations = []; },
  };
  const subscribe = (name: string) => (listener: (...args: any[]) => void) => {
    listeners.set(name, listener);
    return { dispose: () => listeners.delete(name) };
  };
  const editor = {
    createDecorationsCollection: () => collection,
    getModel: () => hasModel ? { getLineCount: () => 40 } : null,
    onMouseMove: subscribe("move"),
    onMouseLeave: subscribe("leave"),
    onDidScrollChange: subscribe("scroll"),
    onDidChangeModel: subscribe("model"),
    onDidChangeModelContent: subscribe("content"),
  } as unknown as MonacoTypes.editor.IStandaloneCodeEditor;
  const monaco = {
    Range: class {
      constructor(
        readonly startLineNumber: number, readonly startColumn: number,
        readonly endLineNumber: number, readonly endColumn: number,
      ) {}
    },
    editor: { MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 } },
  } as unknown as MonacoApi;
  const controller = new BreakpointGutterController(
    monaco, editor, (line) => enabled && !occupied.has(line),
  );
  return {
    controller, listeners, occupied,
    get decorations() { return decorations; },
    get changes() { return changes; },
    set enabled(value: boolean) { enabled = value; },
    set hasModel(value: boolean) { hasModel = value; },
    move(line: number | null, type = 2) {
      listeners.get("move")!({ target: { type, position: line === null ? null : { lineNumber: line } } });
    },
  };
}

test("only glyph-margin hover shows a transient add affordance, without decorating every line", () => {
  const h = harness();
  assert.equal(h.decorations.length, 0);
  h.move(16);
  assert.equal(h.decorations.length, 1);
  assert.equal(h.decorations[0]?.range.startLineNumber, 16);
  assert.equal(h.decorations[0]?.options.glyphMarginClassName, "devmode-debug-breakpoint is-preview");
  assert.match((h.decorations[0]?.options.glyphMarginHoverMessage as { value: string }).value, /Click to add breakpoint/);
  h.move(16);
  assert.equal(h.changes, 1, "moving within a line does not rebuild its decoration");
  h.move(18);
  assert.equal(h.decorations[0]?.range.startLineNumber, 18);
  h.move(18, 6);
  assert.equal(h.decorations.length, 0, "code and line-number hover leave no ghost");
  h.controller.destroy();
});

test("stored breakpoints and execution arrows suppress the preview; updates reconcile the hovered line", () => {
  const h = harness();
  h.move(16);
  h.occupied.add(16);
  h.controller.refresh();
  assert.equal(h.decorations.length, 0);
  h.occupied.delete(16);
  h.controller.refresh();
  assert.equal(h.decorations[0]?.range.startLineNumber, 16);
  h.enabled = false;
  h.controller.refresh();
  assert.equal(h.decorations.length, 0);
  h.controller.destroy();
});

test("hover clears when leaving, scrolling, switching files, or editing", () => {
  const h = harness();
  for (const event of ["leave", "scroll", "model", "content"]) {
    h.move(16);
    h.listeners.get(event)!();
    assert.equal(h.decorations.length, 0, event);
    h.controller.refresh();
    assert.equal(h.decorations.length, 0, `${event}: refresh must not restore a stale hover`);
  }
  h.controller.destroy();
});

test("missing models and invalid target lines never create a decoration", () => {
  const h = harness();
  for (const line of [null, 0, 41]) {
    h.move(line);
    assert.equal(h.decorations.length, 0);
  }
  h.hasModel = false;
  h.move(16);
  assert.equal(h.decorations.length, 0);
  h.controller.destroy();
});

test("destroy removes all event listeners and the preview", () => {
  const h = harness();
  h.move(16);
  h.controller.destroy();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.decorations.length, 0);
});
