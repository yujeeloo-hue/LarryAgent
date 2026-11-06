/**
 * Document Outline — symbols in the active editor file.
 *
 * Sits under the Solution file tree in the Dev Mode sidebar. Scans the live
 * buffer (unsaved edits included); click jumps to the declaration. The
 * caret line highlights the current symbol.
 *
 * C++ implementation files overlay the sibling header (Unreal Private →
 * Public) so Outline lists header `public` / `private` / `protected`
 * members instead of `.cpp` bodies.
 */
import {
  isCppSourcePath,
  siblingHeaderCandidates,
} from "./cppHeaderOutline.js";
import {
  filterDocumentSymbols,
  scanDocumentSymbols,
  symbolIndexAtLine,
  symbolMatchesQuery,
  type DocumentSymbol,
} from "./documentSymbols.js";
import { DocumentOutlineView, type DocumentOutlineRow } from "./DocumentOutlineView.js";

export type DocumentOutlineDeps = {
  getActiveDocument: () => { path: string; text: string } | null;
  revealLine: (path: string, line: number) => void;
  /** Read a sibling header (live tab text, else disk). Missing → null. */
  readFile?: (path: string) => Promise<string | null>;
  /**
   * Scoped fallback header resolution for engine-style nesting
   * (Private/Foo.cpp → Classes/**\/Foo.h). Missing → exact candidates only.
   */
  resolveHeader?: (sourcePath: string) => Promise<string | null>;
};

const HEIGHT_KEY = "jellybot.devmode.docOutlineHeight";
const COLLAPSED_KEY = "jellybot.devmode.docOutlineCollapsed";
const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 108;
const MAX_RATIO = 0.55;
const TREE_RESERVE = 120;
const REFRESH_MS = 160;

function readHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    if (!raw) return DEFAULT_HEIGHT;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function writeHeight(px: number): void {
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(px)));
  } catch {
    // quota / private mode
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // quota / private mode
  }
}

function memberCount(symbols: readonly DocumentSymbol[]): number {
  return symbols.filter((symbol) => symbol.kind !== "access").length;
}

export class DocumentOutlineController {
  readonly view = new DocumentOutlineView();

  private collapsed = readCollapsed();
  private heightPx = readHeight();
  private symbols: DocumentSymbol[] = [];
  private cursorLine = 1;
  /** Editor tab currently in view. */
  private editorPath: string | null = null;
  /** File the outline rows belong to (header when overlaying a `.cpp`). */
  private outlinePath: string | null = null;
  private refreshTimer: number | null = null;
  private refreshGen = 0;
  private loadPromise: Promise<void> = Promise.resolve();
  private filterQuery = "";
  private dragging = false;
  private dragStartY = 0;
  private dragStartHeight = 0;
  private readonly onPointerMove = (event: PointerEvent): void =>
    this.handlePointerMove(event);
  private readonly onPointerUp = (event: PointerEvent): void =>
    this.handlePointerUp(event);

  constructor(private readonly deps: DocumentOutlineDeps) {
    this.view.onToggleCollapse = () => this.setCollapsed(!this.collapsed);
    this.view.onSelectLine = (line) => {
      if (!this.outlinePath) return;
      this.deps.revealLine(this.outlinePath, line);
    };
    this.view.onFilterChange = (query) => {
      this.filterQuery = query;
      this.render();
    };
    this.view.onFilterSubmit = () => this.revealFirstMatch();
    this.view.setCollapsed(this.collapsed);
    this.view.setHeight(this.heightPx);
    this.wireResize();
    void this.refresh();
  }

  /** Immediate rescan (tab switch / close). */
  refresh(): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const doc = this.deps.getActiveDocument();
    this.editorPath = doc?.path ?? null;
    if (!doc) {
      this.refreshGen += 1;
      this.outlinePath = null;
      this.symbols = [];
      this.render();
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }
    if (isCppSourcePath(doc.path)) {
      const gen = ++this.refreshGen;
      this.loadPromise = this.loadCppOutline(doc.path, gen);
      return this.loadPromise;
    }
    this.refreshGen += 1;
    this.outlinePath = doc.path;
    this.symbols = scanDocumentSymbols(doc.text, { path: doc.path });
    this.render();
    this.loadPromise = Promise.resolve();
    return this.loadPromise;
  }

  /** Coalesce keystrokes while the buffer is being edited. */
  scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_MS);
  }

  setCursorLine(line: number): void {
    if (line < 1 || line === this.cursorLine) return;
    this.cursorLine = line;
    this.render();
  }

  destroy(): void {
    this.refreshGen += 1;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.teardownDrag();
    this.view.root.remove();
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.view.setCollapsed(collapsed);
    writeCollapsed(collapsed);
  }

  private render(emptyHint?: string): void {
    if (!this.editorPath) {
      this.view.setEmpty("Open a file to see its outline.");
      return;
    }
    if (this.symbols.length === 0) {
      this.view.setEmpty(emptyHint ?? "No symbols in this file.");
      return;
    }
    const query = this.filterQuery;
    const visible = filterDocumentSymbols(this.symbols, query);
    const total = memberCount(this.symbols);
    const filtering = query.trim().length > 0;
    const matched = filtering
      ? visible.filter(
          (symbol) =>
            symbol.kind !== "access" && symbolMatchesQuery(symbol, query),
        ).length
      : total;
    const countText = filtering ? `${matched} / ${total}` : String(total);
    if (visible.length === 0) {
      this.view.setEmpty("No matching symbols.", countText);
      return;
    }
    const followCursor = this.outlinePath === this.editorPath;
    const activeIndex = followCursor
      ? symbolIndexAtLine(this.symbols, this.cursorLine)
      : -1;
    const activeSymbol = activeIndex >= 0 ? this.symbols[activeIndex] : null;
    this.view.setRows(
      visible.map((symbol) => {
        const row: DocumentOutlineRow = {
          name: symbol.name,
          kind: symbol.kind,
          depth: symbol.depth,
          line: symbol.line,
          active: symbol === activeSymbol,
        };
        if (symbol.params !== undefined) row.params = symbol.params;
        if (symbol.returnType) row.returnType = symbol.returnType;
        return row;
      }),
      countText,
    );
  }

  private revealFirstMatch(): void {
    if (!this.outlinePath) return;
    const visible = filterDocumentSymbols(this.symbols, this.filterQuery);
    const first =
      visible.find(
        (symbol) =>
          symbol.kind !== "access" &&
          symbolMatchesQuery(symbol, this.filterQuery),
      ) ?? visible[0];
    if (!first) return;
    this.deps.revealLine(this.outlinePath, first.line);
  }

  private async loadCppOutline(sourcePath: string, gen: number): Promise<void> {
    const sibling = await this.loadSiblingHeader(sourcePath);
    if (gen !== this.refreshGen) return;
    if (this.editorPath !== sourcePath) return;
    if (!sibling) {
      this.outlinePath = null;
      this.symbols = [];
      this.render("No header declarations for this file.");
      return;
    }
    this.outlinePath = sibling.path;
    this.symbols = scanDocumentSymbols(sibling.text, { path: sibling.path });
    this.render();
  }

  private async loadSiblingHeader(
    sourcePath: string,
  ): Promise<{ path: string; text: string } | null> {
    const read = this.deps.readFile;
    if (!read) return null;
    for (const path of siblingHeaderCandidates(sourcePath)) {
      try {
        const text = await read(path);
        if (text !== null) return { path, text };
      } catch {
        // try the next candidate
      }
    }
    // Exact candidates missed — engine modules nest headers deeper than
    // sources, so resolution needs the scoped search fallback.
    const resolved = this.deps.resolveHeader
      ? await this.deps.resolveHeader(sourcePath)
      : null;
    if (!resolved) return null;
    try {
      const text = await read(resolved);
      return text !== null ? { path: resolved, text } : null;
    } catch {
      return null;
    }
  }

  private wireResize(): void {
    const handle = this.view.resizeHandle;
    handle.setAttribute("aria-valuemin", String(MIN_HEIGHT));
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.collapsed) return;
      event.preventDefault();
      this.dragging = true;
      this.dragStartY = event.clientY;
      this.dragStartHeight = this.heightPx;
      this.view.root.classList.add("is-resizing");
      handle.classList.add("is-dragging");
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // linkedom / tests
      }
      window.addEventListener("pointermove", this.onPointerMove);
      window.addEventListener("pointerup", this.onPointerUp);
      window.addEventListener("pointercancel", this.onPointerUp);
    });
    handle.addEventListener("keydown", (event) => {
      if (this.collapsed) return;
      const step = event.shiftKey ? 48 : 16;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.applyHeight(this.heightPx + step, true);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.applyHeight(this.heightPx - step, true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.applyHeight(DEFAULT_HEIGHT, true);
      }
    });
    handle.addEventListener("dblclick", () => {
      if (this.collapsed) return;
      this.applyHeight(DEFAULT_HEIGHT, true);
    });
  }

  private parentHeight(): number {
    const parent = this.view.root.parentElement;
    if (!parent) return 0;
    return parent.getBoundingClientRect().height;
  }

  private clampHeight(px: number): number {
    const parentH = this.parentHeight();
    let max = 4096;
    if (parentH > 0) {
      max = Math.max(
        MIN_HEIGHT,
        Math.min(
          Math.round(parentH * MAX_RATIO),
          parentH - TREE_RESERVE,
        ),
      );
    }
    return Math.min(max, Math.max(MIN_HEIGHT, Math.round(px)));
  }

  private applyHeight(px: number, persist: boolean): void {
    this.heightPx = this.clampHeight(px);
    this.view.setHeight(this.heightPx);
    if (persist) writeHeight(this.heightPx);
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    const next = this.dragStartHeight + (this.dragStartY - event.clientY);
    this.applyHeight(next, false);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    try {
      this.view.resizeHandle.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    this.teardownDrag();
    writeHeight(this.heightPx);
  }

  private teardownDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.view.root.classList.remove("is-resizing");
    this.view.resizeHandle.classList.remove("is-dragging");
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
  }
}
