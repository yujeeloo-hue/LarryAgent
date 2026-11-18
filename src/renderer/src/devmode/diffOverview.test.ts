import assert from "node:assert/strict";
import test from "node:test";
import type { editor } from "monaco-editor";
import { bindDiffOverview } from "./diffOverview.js";

function harness() {
  let changes: editor.ILineChange[] | null = null;
  const updates: boolean[] = [], changed = new Set<() => void>(), models = new Set<() => void>();
  const diff = {
    getLineChanges: () => changes,
    onDidUpdateDiff: (listener: () => void) => { changed.add(listener); return { dispose: () => changed.delete(listener) }; },
    onDidChangeModel: (listener: () => void) => { models.add(listener); return { dispose: () => models.delete(listener) }; },
    updateOptions: (options: editor.IDiffEditorOptions) => updates.push(options.renderOverviewRuler!),
  };
  const binding = bindDiffOverview(diff);
  return { binding, updates, setChanges: (next: editor.ILineChange[] | null) => { changes = next; changed.forEach(listener => listener()); },
    replaceModel: () => models.forEach(listener => listener()), listenerCount: () => changed.size + models.size };
}
const difference = [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }];

test("the overview appears for actual changes and disappears when the files match again", () => {
  const h = harness();
  try {
    assert.deepEqual(h.updates, [false]);
    h.setChanges([]); assert.deepEqual(h.updates, [false]);
    h.setChanges(difference); h.setChanges(difference); assert.deepEqual(h.updates, [false, true]);
    h.setChanges([]); assert.deepEqual(h.updates, [false, true, false]);
  } finally { h.binding.dispose(); }
});

test("switching files clears the previous overview until the new comparison completes", () => {
  const h = harness();
  h.setChanges(difference); h.replaceModel();
  assert.deepEqual(h.updates, [false, true, false]);
  h.setChanges(null); h.setChanges(difference); assert.deepEqual(h.updates, [false, true, false, true]);
  h.binding.dispose(); assert.equal(h.listenerCount(), 0);
  h.setChanges([]); assert.deepEqual(h.updates, [false, true, false, true]);
});
