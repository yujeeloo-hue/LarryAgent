/**
 * Dev Mode find / replace widget — custom chrome for Monaco's match APIs.
 *
 * Why custom: the built-in widget's overlay, keybindings, and styling never
 * matched the app's frosted-panel language. This widget keeps `findMatches`
 * / `executeEdits` and renders FindWidgetView instead.
 *
 * Behavior:
 *   - ⌘F / Ctrl+F opens find (seeded with selection); Esc closes.
 *   - Ctrl+H / ⌘⌥F expands the replace row on the same panel.
 *   - Enter / ↓ next match, Shift+Enter / ↑ previous.
 *   - Replace field: Enter replaces current; ⌘/Ctrl+Enter replaces all.
 *   - Toggles: case-sensitive, whole-word, regex — persisted in memory.
 *   - Matches painted via decorations; the current match is revealed centered.
 *   - Switching tabs while open re-runs the search on the new model.
 */
import type * as MonacoTypes from "monaco-editor";
import type { EditorAreaController } from "./EditorAreaController.js";
import {
  expandReplacePattern,
  positionAfterInsert,
  type FindWidgetMode,
} from "./findReplace.js";
import { FindWidgetView } from "./FindWidgetView.js";
import "./devmode.css";

export type { FindWidgetMode };

type FindHit = {
  range: MonacoTypes.Range;
  text: string;
  groups: string[] | null;
};

type FindState = {
  query: string;
  replaceQuery: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  replaceOpen: boolean;
};

export class FindWidgetController {
  readonly view = new FindWidgetView();

  private visible = false;
  private replaceOpen = false;
  private query = "";
  private replaceQuery = "";
  private caseSensitive = false;
  private wholeWord = false;
  private useRegex = false;
  private decorations: MonacoTypes.editor.IEditorDecorationsCollection | null =
    null;
  private matches: FindHit[] = [];
  private current = -1;
  private searchTimer: number | null = null;

  constructor(private readonly editorArea: EditorAreaController) {
    const view = this.view;
    view.onFindInput = (value) => {
      this.query = value;
      this.scheduleSearch();
    };
    view.onReplaceInput = (value) => {
      this.replaceQuery = value;
    };
    view.onFindKeydown = (event) => this.handleFindKey(event);
    view.onReplaceKeydown = (event) => this.handleReplaceKey(event);
    view.onPrev = () => this.move(-1);
    view.onNext = () => this.move(1);
    view.onClose = () => this.close();
    view.onToggleCase = (on) => {
      this.caseSensitive = on;
      this.scheduleSearch();
    };
    view.onToggleWord = (on) => {
      this.wholeWord = on;
      this.scheduleSearch();
    };
    view.onToggleRegex = (on) => {
      this.useRegex = on;
      this.scheduleSearch();
    };
    view.onToggleReplace = () => this.setReplaceOpen(!this.replaceOpen);
    view.onReplace = () => this.replaceCurrent();
    view.onReplaceAll = () => this.replaceAll();
  }

  /** Overlay host — DevModeController wires it to the editor pane. */
  mount(host: HTMLElement): void {
    host.append(this.view.root);
  }

  destroy(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.decorations?.clear();
    this.decorations = null;
    this.view.root.remove();
  }

  get isOpen(): boolean {
    return this.visible;
  }

  /**
   * Open (or re-focus) the widget. `replace` expands the second row;
   * `find` leaves replace visibility as the user last left it.
   */
  open(mode: FindWidgetMode = "find"): void {
    const editor = this.editorArea.activeEditor;
    if (!editor) return;
    this.visible = true;
    this.view.setHidden(false);
    if (mode === "replace") this.setReplaceOpen(true);
    if (!this.view.inWidget) {
      const sel = editor.getSelection();
      const seed = sel ? editor.getModel()?.getValueInRange(sel) ?? "" : "";
      if (seed && seed.length <= 200 && !seed.includes("\n")) {
        this.view.setFindValue(seed);
        this.query = seed;
      }
    }
    if (mode === "replace" && this.query) this.view.focusReplace(true);
    else this.view.focusFind(true);
    this.scheduleSearch();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.view.setHidden(true);
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.clearDecorations();
    this.editorArea.activeEditor?.focus();
  }

  /** Tab switched / model swapped while open — re-run on the new model. */
  notifyModelChanged(): void {
    if (!this.visible) return;
    this.scheduleSearch();
  }

  get state(): FindState {
    return {
      query: this.query,
      replaceQuery: this.replaceQuery,
      caseSensitive: this.caseSensitive,
      wholeWord: this.wholeWord,
      regex: this.useRegex,
      replaceOpen: this.replaceOpen,
    };
  }

  private setReplaceOpen(open: boolean): void {
    this.replaceOpen = open;
    this.view.setReplaceOpen(open);
  }

  private handleFindKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.move(event.shiftKey ? -1 : 1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      this.move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.move(-1);
    }
  }

  private handleReplaceKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.replaceAll();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.replaceCurrent();
    }
  }

  private scheduleSearch(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      this.runSearch();
    }, 120);
  }

  private runSearch(): void {
    if (!this.visible) return;
    const editor = this.editorArea.activeEditor;
    const monaco = this.editorArea.monacoApi;
    const model = this.editorArea.activeModel;
    this.clearDecorations();
    if (!editor || !monaco || !model) {
      this.matches = [];
      this.current = -1;
      this.renderCount();
      return;
    }

    const query = this.query;
    if (!query || query === ".") {
      this.matches = [];
      this.current = -1;
      this.renderCount();
      return;
    }

    let hits: FindHit[];
    try {
      hits = model
        .findMatches(
          query,
          /* searchOnlyEditableRange */ false,
          this.useRegex,
          this.caseSensitive,
          this.useRegex ? null : this.wordBoundarySeparator,
          /* captureMatches */ true,
        )
        .map((m) => ({
          range: m.range,
          text: model.getValueInRange(m.range),
          groups: m.matches ?? null,
        }));
    } catch {
      this.matches = [];
      this.current = -1;
      this.renderCount();
      return;
    }
    this.matches = hits;

    if (hits.length === 0) {
      this.current = -1;
      this.renderCount();
      return;
    }

    const pos = editor.getPosition();
    let start = 0;
    if (pos) {
      for (let i = 0; i < hits.length; i++) {
        const m = hits[i]!.range;
        if (
          m.startLineNumber > pos.lineNumber ||
          (m.startLineNumber === pos.lineNumber &&
            m.startColumn >= pos.column)
        ) {
          start = i;
          break;
        }
      }
    }
    this.current = start;

    const decos = hits.map((hit, i) => ({
      range: hit.range,
      options: {
        className: i === start ? "findmatch-current" : "findmatch-other",
        stickiness: 1,
      } as MonacoTypes.editor.IModelDecorationOptions,
    }));
    this.decorations = editor.createDecorationsCollection(decos);
    this.revealCurrent();
    this.renderCount();
  }

  private get wordBoundarySeparator(): string | null {
    return this.wholeWord ? " " : null;
  }

  private move(delta: 1 | -1): void {
    if (this.matches.length === 0) return;
    const next =
      (this.current + delta + this.matches.length) % this.matches.length;
    this.current = next;
    this.paintCurrent();
    this.revealCurrent();
    this.renderCount();
  }

  private paintCurrent(): void {
    if (!this.decorations) return;
    const editor = this.editorArea.activeEditor;
    const monaco = this.editorArea.monacoApi;
    if (!editor || !monaco) return;
    const decos = this.matches.map((hit, i) => ({
      range: hit.range,
      options: {
        className:
          i === this.current ? "findmatch-current" : "findmatch-other",
        stickiness: 1,
      } as MonacoTypes.editor.IModelDecorationOptions,
    }));
    this.decorations.set(decos);
  }

  private revealCurrent(): void {
    const editor = this.editorArea.activeEditor;
    const match = this.matches[this.current];
    if (!editor || !match) return;
    editor.revealRangeInCenter(match.range);
    editor.setPosition({
      lineNumber: match.range.startLineNumber,
      column: match.range.startColumn,
    });
  }

  private clearDecorations(): void {
    this.decorations?.clear();
    this.decorations = null;
  }

  private renderCount(): void {
    if (this.matches.length === 0) {
      this.view.setCount(this.query.trim() ? "No results" : "");
    } else {
      this.view.setCount(`${this.current + 1} / ${this.matches.length}`);
    }
    this.view.setReplaceEnabled(this.matches.length > 0);
  }

  private replacementFor(hit: FindHit): string {
    return expandReplacePattern(
      this.replaceQuery,
      hit.text,
      hit.groups,
      this.useRegex,
    );
  }

  private replaceCurrent(): void {
    if (!this.replaceOpen) this.setReplaceOpen(true);
    const editor = this.editorArea.activeEditor;
    const hit = this.matches[this.current];
    if (!editor || !hit) return;
    const text = this.replacementFor(hit);
    const startLine = hit.range.startLineNumber;
    const startCol = hit.range.startColumn;
    const ok = editor.executeEdits("find-replace", [
      { range: hit.range, text, forceMoveMarkers: true },
    ]);
    if (!ok) return;
    editor.setPosition(positionAfterInsert(startLine, startCol, text));
    this.runSearch();
  }

  private replaceAll(): void {
    if (!this.replaceOpen) this.setReplaceOpen(true);
    const editor = this.editorArea.activeEditor;
    if (!editor || this.matches.length === 0) return;
    const edits = this.matches
      .map((hit) => ({
        range: hit.range,
        text: this.replacementFor(hit),
        forceMoveMarkers: true,
      }))
      .reverse();
    const ok = editor.executeEdits("find-replace", edits);
    if (!ok) return;
    this.runSearch();
  }
}
