import type { editor, IDisposable } from "monaco-editor";

type DiffEditor = Pick<editor.IDiffEditor, "getLineChanges" | "onDidUpdateDiff" | "onDidChangeModel" | "updateOptions">;

export function bindDiffOverview(diff: DiffEditor): IDisposable {
  let visible: boolean | null = null;
  const setVisible = (next: boolean): void => {
    if (next === visible) return;
    visible = next;
    diff.updateOptions({ renderOverviewRuler: next });
  };
  const update = (): void => setVisible((diff.getLineChanges()?.length ?? 0) > 0);
  const listeners = [
    diff.onDidUpdateDiff(update),
    diff.onDidChangeModel(() => setVisible(false)),
  ];
  update();
  return { dispose: () => listeners.forEach(listener => listener.dispose()) };
}
