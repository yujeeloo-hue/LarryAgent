import type * as MonacoTypes from "monaco-editor";
import {
  type DebugHoverNode,
  DebugHoverController,
} from "./DebugHoverController.js";
import { ChevronRight, createLucideIcon } from "../ui/originalIcons.js";
import type { MonacoApi } from "./monacoSetup.js";

const HOVER_DELAY_MS = 320;
const HIDE_DELAY_MS = 180;
const MAX_CHILDREN_PER_NODE = 200;

const MEMBER_EXPRESSION =
  /[A-Za-z_]\w*(?:(?:\s*->\s*|\s*\.\s*)[A-Za-z_]\w*)*/g;

export function debugExpressionAt(
  line: string,
  column: number,
): { expression: string; startColumn: number; endColumn: number } | null {
  const cursor = Math.max(0, column - 1);
  for (const match of line.matchAll(MEMBER_EXPRESSION)) {
    const start = match.index;
    const end = start + match[0].length;
    if (cursor < start || cursor > end) continue;
    const expression = match[0].replace(/\s+/g, "");
    return {
      expression,
      startColumn: start + 1,
      endColumn: end + 1,
    };
  }
  return null;
}

/** Interactive, lazily-expanded DAP variable hover. */
export class DebugHoverView {
  private readonly root = document.createElement("div");
  private readonly disposables: MonacoTypes.IDisposable[] = [];
  private showTimer: number | null = null;
  private hideTimer: number | null = null;
  private requestEpoch = 0;
  private lastKey = "";

  constructor(
    private readonly monaco: MonacoApi,
    private readonly editor: MonacoTypes.editor.IStandaloneCodeEditor,
    private readonly controller: DebugHoverController,
  ) {
    this.root.className = "devmode-debug-hover";
    this.root.hidden = true;
    this.root.addEventListener("mouseenter", () => this.cancelHide());
    this.root.addEventListener("mouseleave", () => this.scheduleHide());
    document.body.append(this.root);
    this.disposables.push(
      editor.onMouseMove((event) => this.onMouseMove(event)),
      editor.onMouseLeave(() => this.scheduleHide()),
      editor.onDidScrollChange(() => this.hide()),
      editor.onDidChangeModel(() => this.hide()),
    );
  }

  destroy(): void {
    this.requestEpoch += 1;
    this.controller.invalidate();
    this.clearTimers();
    for (const disposable of this.disposables) disposable.dispose();
    this.root.remove();
  }

  private onMouseMove(event: MonacoTypes.editor.IEditorMouseEvent): void {
    const position = event.target.position;
    const model = this.editor.getModel();
    if (
      !position ||
      !model ||
      event.target.type !== this.monaco.editor.MouseTargetType.CONTENT_TEXT
    ) {
      if (!this.root.matches(":hover")) this.scheduleHide();
      return;
    }
    const target = debugExpressionAt(
      model.getLineContent(position.lineNumber),
      position.column,
    );
    if (!target) {
      this.scheduleHide();
      return;
    }
    const key = `${model.uri.toString()}:${position.lineNumber}:${target.expression}`;
    if (key === this.lastKey && !this.root.hidden) {
      this.cancelHide();
      return;
    }
    this.lastKey = key;
    this.cancelHide();
    if (this.showTimer !== null) window.clearTimeout(this.showTimer);
    const epoch = ++this.requestEpoch;
    this.showTimer = window.setTimeout(() => {
      this.showTimer = null;
      void this.show(target.expression, position, epoch);
    }, HOVER_DELAY_MS);
  }

  private async show(
    expression: string,
    position: MonacoTypes.Position,
    epoch: number,
  ): Promise<void> {
    const value = await this.controller.evaluate(expression);
    if (!value || epoch !== this.requestEpoch) return;
    const head = document.createElement("div");
    head.className = "devmode-debug-hover-head";
    const name = document.createElement("code");
    name.textContent = expression;
    const type = document.createElement("span");
    type.textContent = value.type ?? "value";
    head.append(name, type);
    const tree = document.createElement("div");
    tree.className = "devmode-debug-hover-tree";
    tree.append(
      this.variableRow(value, true),
    );
    this.root.replaceChildren(head, tree);
    this.root.hidden = false;
    this.position(position);
  }

  private variableRow(
    variable: DebugHoverNode,
    root = false,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "devmode-debug-hover-node";
    const row = document.createElement("div");
    row.className = root
      ? "devmode-debug-hover-row is-root"
      : "devmode-debug-hover-row";
    row.style.setProperty("--debug-hover-depth", String(variable.depth));
    const expandable = variable.expandable;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "devmode-debug-hover-toggle";
    toggle.disabled = !expandable;
    toggle.setAttribute(
      "aria-label",
      expandable ? `Expand ${variable.name}` : `${variable.name} has no children`,
    );
    if (expandable) {
      // SVG glyph (not a text node) so the 14px button centers it with
      // flex and the rotation transform cannot offset it vertically.
      toggle.append(createLucideIcon(ChevronRight, { size: 12 }));
    }
    const name = document.createElement("span");
    name.className = "devmode-debug-hover-name";
    name.textContent = variable.name;
    const value = document.createElement("code");
    value.className = "devmode-debug-hover-value";
    value.textContent = variable.value;
    value.title = variable.value;
    const type = document.createElement("span");
    type.className = "devmode-debug-hover-type";
    type.textContent =
      variable.terminalReason === "cycle"
        ? "cycle"
        : variable.terminalReason === "max-depth"
          ? "max depth"
          : variable.type ?? "";
    row.append(toggle, name, value, type);
    wrap.append(row);
    if (expandable) {
      toggle.addEventListener("click", () => {
        void this.toggleNode(wrap, toggle, variable);
      });
    }
    return wrap;
  }

  private async toggleNode(
    wrap: HTMLElement,
    toggle: HTMLButtonElement,
    variable: DebugHoverNode,
  ): Promise<void> {
    const existing = wrap.querySelector<HTMLElement>(
      ":scope > .devmode-debug-hover-children",
    );
    if (existing) {
      existing.hidden = !existing.hidden;
      toggle.classList.toggle("is-open", !existing.hidden);
      return;
    }
    toggle.classList.add("is-loading");
    toggle.disabled = true;
    try {
      const variables = await this.controller.expand(variable);
      if (!wrap.isConnected) return;
      const children = document.createElement("div");
      children.className = "devmode-debug-hover-children";
      let shown = 0;
      const appendNext = (): void => {
        const end = Math.min(shown + MAX_CHILDREN_PER_NODE, variables.length);
        for (const child of variables.slice(shown, end)) {
          children.append(
            this.variableRow(child),
          );
        }
        shown = end;
        if (shown < variables.length) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "devmode-debug-hover-more is-action";
          more.textContent =
            `Show next ${Math.min(MAX_CHILDREN_PER_NODE, variables.length - shown)}` +
            ` · ${variables.length - shown} remaining`;
          more.addEventListener("click", () => {
            more.remove();
            appendNext();
          });
          children.append(more);
        }
      };
      if (variables.length > 0) {
        appendNext();
      } else {
        const empty = document.createElement("div");
        empty.className = "devmode-debug-hover-more";
        empty.textContent = "No properties";
        children.append(empty);
      }
      wrap.append(children);
      toggle.classList.add("is-open");
    } catch (err) {
      if (wrap.isConnected) {
        const error = document.createElement("div");
        error.className = "devmode-debug-hover-more is-error";
        error.textContent =
          err instanceof Error ? err.message : "Could not load properties";
        wrap.append(error);
      }
    } finally {
      toggle.classList.remove("is-loading");
      toggle.disabled = false;
    }
  }

  private position(position: MonacoTypes.Position): void {
    const visible = this.editor.getScrolledVisiblePosition(position);
    const dom = this.editor.getDomNode();
    if (!visible || !dom) return;
    const rect = dom.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - this.root.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - this.root.offsetHeight - 8);
    this.root.style.left = `${Math.min(maxLeft, rect.left + visible.left)}px`;
    this.root.style.top =
      `${Math.min(maxTop, rect.top + visible.top + visible.height + 4)}px`;
  }

  private scheduleHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private hide(): void {
    this.requestEpoch += 1;
    this.controller.invalidate();
    this.clearTimers();
    this.lastKey = "";
    this.root.hidden = true;
  }

  private clearTimers(): void {
    if (this.showTimer !== null) window.clearTimeout(this.showTimer);
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.showTimer = null;
    this.hideTimer = null;
  }
}
