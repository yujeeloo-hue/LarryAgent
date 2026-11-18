import type * as MonacoTypes from "monaco-editor";
import { disableCtrlClickGoto } from "./goToDefinition.js";
import type { MonacoApi } from "./monacoSetup.js";
import { resolveDevModeTheme } from "./monacoSetup.js";
import { EditorDiffView } from "./EditorDiffView.js";
import { devModeDiffLayout, devModeEditorScrollbar } from "./editorStyle.js";
import { bindDiffOverview } from "./diffOverview.js";

export type EditorDiffDocument = {
  path: string;
  languageId: string;
  model: MonacoTypes.editor.ITextModel;
  readOnly: boolean;
};

export type EditorDiffControllerOptions = {
  getWorkspaceRoot: () => string | null;
  getMinimapEnabled: () => boolean;
  onModeChanged: (enabled: boolean) => void;
  onLoadingChange?: (loading: boolean) => void;
};

export class EditorDiffController {
  readonly view = new EditorDiffView();
  private monaco: MonacoApi | null = null;
  private editor: MonacoTypes.editor.IStandaloneDiffEditor | null = null;
  private overview: MonacoTypes.IDisposable | null = null;
  private originalModel: MonacoTypes.editor.ITextModel | null = null;
  private enabled = false;
  private activePath: string | null = null;
  private generation = 0;

  constructor(private readonly options: EditorDiffControllerOptions) {}

  setMonaco(monaco: MonacoApi): void {
    this.monaco = monaco;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get modifiedEditor(): MonacoTypes.editor.IStandaloneCodeEditor | null {
    return this.editor?.getModifiedEditor() ?? null;
  }

  async toggle(document: EditorDiffDocument | null): Promise<boolean> {
    if (this.enabled) {
      this.disable();
      return false;
    }
    if (!document) return false;
    this.enabled = true;
    this.view.setVisible(true);
    this.options.onModeChanged(true);
    await this.attach(document);
    return true;
  }

  async attach(document: EditorDiffDocument | null): Promise<void> {
    if (!this.enabled) return;
    const generation = ++this.generation;
    this.activePath = document?.path ?? null;
    this.editor?.setModel(null);
    this.disposeOriginalModel();
    if (!document) {
      this.editor?.setModel(null);
      this.view.setError("No file open");
      return;
    }
    const root = this.options.getWorkspaceRoot();
    const bridge = window.jellybot;
    if (!root || !bridge?.getVcsFileBase) {
      this.editor?.setModel(null);
      this.view.setError("Diff needs a version-controlled workspace");
      return;
    }

    this.ensureEditor();
    this.options.onLoadingChange?.(true);
    this.view.setLoading(true);
    try {
      const result = await bridge.getVcsFileBase(root, document.path);
      if (
        generation !== this.generation ||
        !this.enabled ||
        this.activePath !== document.path
      ) {
        return;
      }
      if (!result.ok) {
        this.editor?.setModel(null);
        this.view.setError(`Diff unavailable — ${result.message}`);
        return;
      }
      const monaco = this.monaco;
      if (!monaco || !this.editor) return;
      this.originalModel = monaco.editor.createModel(
        result.content,
        document.languageId,
      );
      this.editor.setModel({
        original: this.originalModel,
        modified: document.model,
      });
      this.editor.updateOptions({
        readOnly: document.readOnly,
        originalEditable: false,
        minimap: { enabled: this.options.getMinimapEnabled() },
      });
      this.view.clearNotice();
      this.editor.layout();
      this.editor.getModifiedEditor().focus();
    } catch (err) {
      if (generation !== this.generation || !this.enabled) return;
      const message = err instanceof Error ? err.message : String(err);
      this.editor?.setModel(null);
      this.view.setError(`Diff unavailable — ${message}`);
    } finally {
      this.options.onLoadingChange?.(false);
    }
  }

  setMinimap(enabled: boolean): void {
    this.editor?.updateOptions({ minimap: { enabled } });
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.generation++;
    this.activePath = null;
    this.editor?.setModel(null);
    this.disposeOriginalModel();
    this.view.clearNotice();
    this.view.setVisible(false);
    this.options.onModeChanged(false);
  }

  destroy(): void {
    this.enabled = false;
    this.generation++;
    this.overview?.dispose(); this.overview = null;
    this.editor?.setModel(null);
    this.disposeOriginalModel();
    this.editor?.dispose();
    this.editor = null;
    this.view.root.remove();
  }

  private ensureEditor(): void {
    if (!this.monaco || this.editor) return;
    this.editor = this.monaco.editor.createDiffEditor(this.view.editorHost, {
      automaticLayout: true,
      theme: resolveDevModeTheme(),
      ...devModeDiffLayout,
      renderOverviewRuler: false,
      originalEditable: false,
      scrollBeyondLastLine: false,
      scrollbar: { ...devModeEditorScrollbar },
      renderWhitespace: "selection",
      fontFamily:
        'ui-monospace, "SF Mono", "JetBrains Mono Var", SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 12.5,
      lineDecorationsWidth: 20,
      minimap: { enabled: this.options.getMinimapEnabled() },
    });
    this.overview = bindDiffOverview(this.editor);
    disableCtrlClickGoto(this.editor.getOriginalEditor());
    disableCtrlClickGoto(this.editor.getModifiedEditor());
  }

  private disposeOriginalModel(): void {
    this.originalModel?.dispose();
    this.originalModel = null;
  }
}
