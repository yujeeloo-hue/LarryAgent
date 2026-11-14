import type * as MonacoTypes from "monaco-editor";
import type { MonacoApi } from "./monacoSetup.js";

/** One transient glyph decoration; never creates a stored breakpoint. */
export class BreakpointGutterController {
  private readonly collection: MonacoTypes.editor.IEditorDecorationsCollection;
  private readonly disposables: MonacoTypes.IDisposable[];
  private hoverLine: number | null = null;
  private previewLine: number | null = null;

  constructor(
    private readonly monaco: MonacoApi,
    private readonly editor: MonacoTypes.editor.IStandaloneCodeEditor,
    private readonly canPreview: (line: number) => boolean,
  ) {
    this.collection = editor.createDecorationsCollection();
    this.disposables = [
      editor.onMouseMove((event) => {
        this.hoverLine =
          event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
            ? event.target.position?.lineNumber ?? null
            : null;
        this.refresh();
      }),
      editor.onMouseLeave(() => this.clear()),
      editor.onDidScrollChange(() => this.clear()),
      editor.onDidChangeModel(() => this.clear()),
      editor.onDidChangeModelContent(() => this.clear()),
    ];
  }

  /** Reconcile the hover after a breakpoint or execution location changes. */
  refresh(): void {
    const model = this.editor.getModel();
    const line =
      model && this.hoverLine !== null &&
      this.hoverLine >= 1 && this.hoverLine <= model.getLineCount() &&
      this.canPreview(this.hoverLine)
        ? this.hoverLine
        : null;
    if (line === this.previewLine) return;
    this.previewLine = line;
    if (line === null) {
      this.collection.clear();
      return;
    }
    this.collection.set([{
      range: new this.monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "devmode-debug-bp-hover-line",
        glyphMarginClassName: "devmode-debug-breakpoint is-preview",
        glyphMarginHoverMessage: {
          value: "Click to add breakpoint.\n\nRight-click or Alt-click to set a condition.",
        },
      },
    }]);
  }

  destroy(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.clear();
  }

  private clear(): void {
    this.hoverLine = null;
    this.previewLine = null;
    this.collection.clear();
  }
}
