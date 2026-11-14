/**
 * Shows blame metadata only while the pointer is over Monaco's line numbers.
 * Model decoration hover targets the code area, which is why the previous
 * tooltip did not appear where users expected it.
 */
import type * as MonacoTypes from "monaco-editor";
import type { MonacoApi } from "./monacoSetup.js";
import {
  blameHoverPlainText,
  type BlameEntry,
  type BlameKind,
} from "./blameFormat.js";
import { BlameHoverView } from "./BlameHoverView.js";

export type ActiveBlame = {
  kind: BlameKind;
  lines: BlameEntry[];
} | null;

export class BlameHoverController {
  private readonly view = new BlameHoverView();
  private moveDisposable: MonacoTypes.IDisposable | null = null;
  private leaveDisposable: MonacoTypes.IDisposable | null = null;
  private cachedLines: BlameEntry[] | null = null;
  private cachedByLine = new Map<number, BlameEntry>();

  bind(
    editor: MonacoTypes.editor.IStandaloneCodeEditor,
    monaco: MonacoApi,
    getActiveBlame: () => ActiveBlame,
  ): void {
    this.unbind();
    this.moveDisposable = editor.onMouseMove((event) => {
      if (
        event.target.type !==
          monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        !event.target.position
      ) {
        this.view.hide();
        return;
      }
      const blame = getActiveBlame();
      if (blame && blame.lines !== this.cachedLines) {
        this.cachedLines = blame.lines;
        this.cachedByLine = new Map(
          blame.lines.map((entry) => [entry.line, entry]),
        );
      }
      const entry = blame
        ? this.cachedByLine.get(event.target.position.lineNumber)
        : undefined;
      if (!blame || !entry) {
        this.view.hide();
        return;
      }
      this.view.show(
        blameHoverPlainText(entry, blame.kind),
        event.event.posx,
        event.event.posy,
      );
    });
    this.leaveDisposable = editor.onMouseLeave(() => this.view.hide());
  }

  hide(): void {
    this.view.hide();
  }

  destroy(): void {
    this.unbind();
    this.view.destroy();
  }

  private unbind(): void {
    this.moveDisposable?.dispose();
    this.moveDisposable = null;
    this.leaveDisposable?.dispose();
    this.leaveDisposable = null;
    this.cachedLines = null;
    this.cachedByLine.clear();
    this.view.hide();
  }
}
