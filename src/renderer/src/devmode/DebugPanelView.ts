import {
  ArrowRight,
  ChevronRight,
  Pencil,
  X,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { createDebugPanelIcon, type DebugPanelIconName } from "./debugIcons.js";
import { frameModuleLabel, frameSourceFile } from "../../../debug/frameSource.js";
import {
  debugColumnTitle,
  debugEmptyTargets,
  debugMissingSourceTitle,
  debugStatusDetail,
  isCdpRecipe,
} from "../../../debug/debugCopy.js";

export type DebugBreakpointRow = {
  path: string;
  line: number;
  condition: string;
  enabled: boolean;
};

function sameDebugLocals(left: DebugVariable[], right: DebugVariable[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const b = right[i]!;
    if (
      a.name !== b.name ||
      a.value !== b.value ||
      a.type !== b.type ||
      a.variablesReference !== b.variablesReference
    ) {
      return false;
    }
  }
  return true;
}

/** UI-relevant shape of a lazily expandable variable tree node. */
export type DebugVariableNode = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  depth: number;
  /** References of this node's ancestors — used to flag reference cycles. */
  ancestors: ReadonlySet<number>;
  expandable: boolean;
};

/** Presentation-only debug panel (Unreal C++, Electron, or Node web). */
export class DebugPanelView {
  readonly root = document.createElement("div");
  private readonly foreign = document.createElement("div");
  private readonly status = document.createElement("div");
  private readonly statusDetail = document.createElement("div");
  private readonly breakpoints = document.createElement("div");
  private readonly clearBreakpoints = document.createElement("button");
  private readonly threads = document.createElement("div");
  private readonly stack = document.createElement("div");
  private readonly locals = document.createElement("div");
  private readonly threadCount = document.createElement("span");
  private readonly stackCount = document.createElement("span");
  private readonly localCount = document.createElement("span");
  private readonly breakpointCount = document.createElement("span");
  readonly continueButton = this.action("Continue (F5)", "continue");
  readonly pauseButton = this.action("Pause", "pause");
  // → over the call, ↓ into it, ↑ back out of it.
  readonly stepOverButton = this.action("Step over (F10)", "step-over");
  readonly stepInButton = this.action("Step in (F11)", "step-in");
  readonly stepOutButton = this.action("Step out (Shift+F11)", "step-out");
  readonly stopButton = this.action("Stop", "stop");
  onFrameSelect: ((frame: DebugStackFrame) => void) | null = null;
  onThreadSelect: ((thread: DebugThread) => void) | null = null;
  onTargetSelect: ((target: DebugTarget) => void) | null = null;
  onBreakpointOpen: ((row: DebugBreakpointRow) => void) | null = null;
  onBreakpointToggleEnabled: ((row: DebugBreakpointRow) => void) | null = null;
  onBreakpointRemove: ((row: DebugBreakpointRow) => void) | null = null;
  onBreakpointEditCondition: ((row: DebugBreakpointRow) => void) | null = null;
  onBreakpointClearAll: (() => void) | null = null;
  /** Lazily loads the children of a Variables column node. */
  onVariableExpand:
    | ((node: DebugVariableNode) => Promise<DebugVariableNode[]> | null)
    | null = null;
  /** Frame ids whose module PDB is being loaded on demand right now. */
  private readonly symbolLoadingFrames = new Set<number>();
  /** Stop stays visually pressed until the debuggee actually goes idle. */
  private stopPending = false;
  /** Last locals painted into the tree — skip rebuilds that would collapse it. */
  private paintedLocals: DebugVariable[] | undefined;
  private lastSnapshot: DebugSnapshot = {
    workspacePath: "",
    status: "idle",
    stack: [],
    locals: [],
  };
  private readonly threadHeading: HTMLHeadingElement;
  constructor() {
    this.root.className = "devmode-debug";
    this.foreign.className = "devmode-debug-foreign";
    this.foreign.hidden = true;
    const toolbar = document.createElement("div");
    toolbar.className = "devmode-debug-toolbar";
    this.continueButton.classList.add("devmode-debug-continue");
    this.stopButton.classList.add("devmode-debug-stop");
    const separator = document.createElement("span");
    separator.className = "devmode-debug-toolbar-sep";
    const state = document.createElement("div");
    state.className = "devmode-debug-state";
    this.statusDetail.className = "devmode-debug-status-detail";
    state.append(this.statusDetail, this.status);
    // Session-level actions stay together, followed by the three step moves.
    toolbar.append(
      this.continueButton,
      this.pauseButton,
      this.stopButton,
      separator,
      this.stepOverButton,
      this.stepInButton,
      this.stepOutButton,
      state,
    );
    const body = document.createElement("div");
    body.className = "devmode-debug-body";
    this.breakpoints.className = "devmode-debug-list devmode-debug-breakpoint-list";
    this.stack.className = "devmode-debug-list devmode-debug-stack-frames";
    this.threads.className = "devmode-debug-list devmode-debug-threads";
    this.locals.className = "devmode-debug-list devmode-debug-variables";
    this.clearBreakpoints.type = "button";
    this.clearBreakpoints.className = "devmode-debug-section-action";
    this.clearBreakpoints.textContent = "Remove all";
    this.clearBreakpoints.hidden = true;
    this.clearBreakpoints.addEventListener("click", () => {
      this.onBreakpointClearAll?.();
    });
    const threadSection = this.column(
      "Threads",
      "threads",
      this.threads,
      this.threadCount,
    );
    threadSection.classList.add("devmode-debug-thread-col");
    this.threadHeading = threadSection.querySelector("h3")!;
    const stackSection = this.column(
      "Call Stack",
      "call-stack",
      this.stack,
      this.stackCount,
    );
    stackSection.classList.add("devmode-debug-stack-col");
    const localsSection = this.column(
      "Variables",
      "variables",
      this.locals,
      this.localCount,
    );
    localsSection.classList.add("devmode-debug-variables-col");
    const breakpointSection = this.column(
      "Breakpoints",
      "breakpoints",
      this.breakpoints,
      this.breakpointCount,
      this.clearBreakpoints,
    );
    breakpointSection.classList.add("devmode-debug-breakpoints-col");
    body.append(
      threadSection,
      this.resizer(body, threadSection, stackSection, 0),
      stackSection,
      this.resizer(body, stackSection, localsSection, 1),
      localsSection,
      this.resizer(body, localsSection, breakpointSection, 2),
      breakpointSection,
    );
    this.root.append(toolbar, this.foreign, body);
    this.setBreakpoints([]);
    this.setSnapshot({
      workspacePath: "",
      status: "idle",
      stack: [],
      locals: [],
    });
  }

  setStopPending(pending: boolean): void {
    this.stopPending = pending;
    this.syncStopControl();
    this.syncStatusLabel();
  }

  /** Banner for a session that keeps running under another workspace. */
  setForeignSession(label: string | null): void {
    this.foreign.hidden = label === null;
    if (label === null) return;
    this.foreign.textContent = `Debugging — ${label}`;
    this.foreign.title =
      "Debugging continues while you are in another project. Switch back to control its breakpoints.";
  }

  setSnapshot(snapshot: DebugSnapshot): void {
    this.lastSnapshot = snapshot;
    this.syncStopControl();
    this.syncStatusLabel();
    this.status.className = [
      "devmode-debug-status",
      `is-${snapshot.status}`,
      this.stopPending && snapshot.status !== "idle" ? "is-stopping" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const selectedThread = snapshot.threads?.find(
      (thread) => thread.id === snapshot.selectedThreadId,
    );
    const selectedTarget = snapshot.targets?.find(
      (target) => target.id === snapshot.selectedTargetId,
    );
    const frame = snapshot.stack[0];
    const framePath = frame ? frameSourceFile(frame) : null;
    const file =
      framePath?.replace(/\\/g, "/").split("/").pop() ??
      (frame ? frameModuleLabel(frame) : null);
    const stoppedLabel = [
      snapshot.recipe && isCdpRecipe(snapshot.recipe)
        ? selectedTarget?.label
        : selectedThread?.name,
      file && framePath && frame?.line
        ? `${file}:${frame.line}`
        : (file ?? undefined),
    ]
      .filter(Boolean)
      .join(" · ");
    this.statusDetail.textContent = debugStatusDetail({
      status: snapshot.status,
      ...(snapshot.recipe ? { recipe: snapshot.recipe } : {}),
      ...(snapshot.progressText ? { progressText: snapshot.progressText } : {}),
      ...(snapshot.program ? { program: snapshot.program } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
      stoppedLabel,
    });
    const paused = snapshot.status === "stopped";
    this.continueButton.disabled = !paused;
    this.pauseButton.disabled = snapshot.status !== "running";
    this.stepOverButton.disabled = !paused;
    this.stepInButton.disabled = !paused;
    this.stepOutButton.disabled = !paused;
    this.threadHeading.textContent = debugColumnTitle(snapshot.recipe);
    if (snapshot.recipe && isCdpRecipe(snapshot.recipe)) {
      this.renderSessions(
        snapshot.targets ?? [],
        snapshot.selectedTargetId,
        snapshot.recipe,
      );
    } else {
      this.renderThreads(
        snapshot.threads ?? [],
        snapshot.selectedThreadId,
        snapshot.status === "stopped",
      );
    }
    this.renderStack(
      snapshot.stack,
      snapshot.selectedFrameId ?? snapshot.stack[0]?.id,
      snapshot.recipe,
    );
    this.renderLocals(snapshot.locals);
  }

  setBreakpoints(rows: DebugBreakpointRow[]): void {
    this.breakpointCount.textContent = String(rows.length);
    this.breakpointCount.hidden = rows.length === 0;
    this.clearBreakpoints.hidden = rows.length === 0;
    this.breakpoints.replaceChildren();
    if (rows.length === 0) {
      this.breakpoints.append(
        this.empty("No breakpoints — click the editor gutter to add one"),
      );
      return;
    }
    for (const row of rows) {
      this.breakpoints.append(this.breakpointRow(row));
    }
  }

  /**
   * Toggle the on-demand symbol-load spinner on one frame row. The state
   * lives here so snapshot re-renders keep it; live rows are patched in
   * place instead of re-rendering the whole stack.
   */
  setFrameSymbolLoading(frameId: number, loading: boolean): void {
    if (loading) this.symbolLoadingFrames.add(frameId);
    else this.symbolLoadingFrames.delete(frameId);
    for (const row of this.stack.querySelectorAll<HTMLElement>(
      `[data-frame-id="${frameId}"]`,
    )) {
      row.classList.toggle("is-pdb-loading", loading);
    }
  }

  private breakpointRow(row: DebugBreakpointRow): HTMLElement {
    const item = document.createElement("div");
    item.className = row.enabled
      ? "devmode-debug-bp"
      : "devmode-debug-bp is-disabled";
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = [
      "devmode-debug-bp-mark",
      row.condition.trim() ? "is-conditional" : "",
      row.enabled ? "" : "is-disabled",
    ]
      .filter(Boolean)
      .join(" ");
    mark.title = row.enabled ? "Disable breakpoint" : "Enable breakpoint";
    mark.setAttribute(
      "aria-label",
      `${row.enabled ? "Disable" : "Enable"} breakpoint at ${row.path}:${row.line}`,
    );
    mark.addEventListener("click", () => {
      this.onBreakpointToggleEnabled?.(row);
    });
    const open = document.createElement("button");
    open.type = "button";
    open.className = "devmode-debug-bp-open";
    const label = document.createElement("strong");
    const file = row.path.replace(/\\/g, "/").split("/").pop() || row.path;
    label.textContent = `${file}:${row.line}`;
    open.title = `${row.path}:${row.line}`;
    open.append(label);
    if (row.condition.trim()) {
      const cond = document.createElement("span");
      cond.className = "devmode-debug-bp-cond";
      cond.textContent = row.condition.trim();
      cond.title = row.condition.trim();
      open.append(cond);
    }
    open.addEventListener("click", () => this.onBreakpointOpen?.(row));
    const edit = this.action("Edit condition", Pencil);
    edit.classList.add("devmode-debug-bp-action");
    edit.addEventListener("click", () => this.onBreakpointEditCondition?.(row));
    const remove = this.action("Remove breakpoint", X);
    remove.classList.add("devmode-debug-bp-action");
    remove.addEventListener("click", () => this.onBreakpointRemove?.(row));
    item.append(mark, open, edit, remove);
    return item;
  }

  private renderStack(
    frames: DebugStackFrame[],
    selectedFrameId?: number,
    recipe?: DebugSnapshot["recipe"],
  ): void {
    this.stackCount.textContent = String(frames.length);
    this.stackCount.hidden = frames.length === 0;
    this.stack.replaceChildren();
    // A spinner may still belong to a frame that left the stack (thread
    // switch, resumed process): drop those ids so they cannot ghost back.
    for (const id of this.symbolLoadingFrames) {
      if (!frames.some((frame) => frame.id === id)) {
        this.symbolLoadingFrames.delete(id);
      }
    }
    if (frames.length === 0) {
      this.stack.append(this.empty("No stack available"));
      return;
    }
    frames.forEach((frame, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = [
        "devmode-debug-row",
        "devmode-debug-frame",
        index === 0 ? "is-current" : "",
        frame.id === selectedFrameId ? "is-selected" : "",
        this.symbolLoadingFrames.has(frame.id) ? "is-pdb-loading" : "",
      ]
        .filter(Boolean)
        .join(" ");
      row.dataset.frameId = String(frame.id);
      const frameIndex = document.createElement("span");
      frameIndex.className = "devmode-debug-frame-index";
      if (index === 0) {
        frameIndex.append(createLucideIcon(ArrowRight, { size: 11 }));
      } else {
        frameIndex.textContent = String(index);
      }
      const name = document.createElement("strong");
      name.className = "devmode-debug-row-main";
      name.textContent = frame.name;
      // The file:line repeats what the editor already shows, so it lives in
      // the tooltip (full path) instead of crowding every row.
      const path = frameSourceFile(frame);
      if (!path) row.classList.add("is-external");
      const module = path ? null : frameModuleLabel(frame);
      row.title = path
        ? `${frame.name}\n${path}${frame.line > 0 ? `:${frame.line}` : ""}`
        : debugMissingSourceTitle(recipe, frame.name, module);
      row.append(frameIndex, name);
      row.addEventListener("click", () => this.onFrameSelect?.(frame));
      this.stack.append(row);
    });
  }

  private renderSessions(
    targets: DebugTarget[],
    selectedTargetId?: string,
    recipe: "electron" | "web" = "electron",
  ): void {
    this.threadCount.textContent = String(targets.length);
    this.threadCount.hidden = targets.length === 0;
    this.threads.replaceChildren();
    if (targets.length === 0) {
      this.threads.append(this.empty(debugEmptyTargets(recipe)));
      return;
    }
    for (const target of targets) {
      const paused = target.status === "stopped";
      const selected = target.id === selectedTargetId;
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        selected && paused
          ? "devmode-debug-thread is-selected"
          : "devmode-debug-thread";
      const dot = document.createElement("span");
      dot.className =
        paused
          ? "devmode-debug-thread-dot is-paused"
          : target.status === "ended"
            ? "devmode-debug-thread-dot"
            : "devmode-debug-thread-dot is-running";
      const name = document.createElement("span");
      name.className = "devmode-debug-row-main";
      name.textContent = target.label;
      row.append(dot, name);
      if (paused) {
        const tag = document.createElement("span");
        tag.className = "devmode-debug-thread-tag";
        tag.textContent = "paused";
        row.append(tag);
      }
      row.title = `${target.label} · ${target.kind}`;
      row.addEventListener("click", () => this.onTargetSelect?.(target));
      this.threads.append(row);
    }
  }

  private renderThreads(
    threads: DebugThread[],
    selectedThreadId?: number,
    paused = false,
  ): void {
    this.threadCount.textContent = String(threads.length);
    this.threadCount.hidden = threads.length === 0;
    this.threads.replaceChildren();
    if (threads.length === 0) {
      this.threads.append(this.empty(debugEmptyTargets("unreal")));
      return;
    }
    for (const thread of threads) {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        paused && thread.id === selectedThreadId
          ? "devmode-debug-thread is-selected"
          : "devmode-debug-thread";
      const dot = document.createElement("span");
      dot.className =
        paused && thread.id === selectedThreadId
          ? "devmode-debug-thread-dot is-paused"
          : "devmode-debug-thread-dot is-running";
      const name = document.createElement("span");
      name.className = "devmode-debug-row-main";
      name.textContent = thread.name || `Thread ${thread.id}`;
      const id = document.createElement("span");
      id.className = "devmode-debug-thread-id";
      id.textContent = String(thread.id);
      row.append(dot, name, id);
      if (paused && thread.id === selectedThreadId) {
        const tag = document.createElement("span");
        tag.className = "devmode-debug-thread-tag";
        tag.textContent = "paused";
        row.append(tag);
      }
      row.title = `${thread.name || "Thread"} · ${thread.id}`;
      row.addEventListener("click", () => this.onThreadSelect?.(thread));
      this.threads.append(row);
    }
  }

  private renderLocals(variables: DebugVariable[]): void {
    this.localCount.textContent = String(variables.length);
    this.localCount.hidden = variables.length === 0;
    if (this.paintedLocals && sameDebugLocals(this.paintedLocals, variables)) {
      return;
    }
    this.paintedLocals = variables;
    this.locals.replaceChildren();
    if (variables.length === 0) {
      this.locals.append(this.empty("No locals available"));
      return;
    }
    for (const variable of variables) {
      this.locals.append(this.variableRow(this.toNode(variable, 0, new Set())));
    }
  }

  private toNode(
    variable: DebugVariable,
    depth: number,
    ancestors: ReadonlySet<number>,
  ): DebugVariableNode {
    const reference = variable.variablesReference;
    const cycle = reference > 0 && ancestors.has(reference);
    return {
      name: variable.name,
      value: variable.value,
      ...(variable.type ? { type: variable.type } : {}),
      variablesReference: reference,
      depth,
      ancestors,
      expandable: reference > 0 && !cycle,
    };
  }

  /** name / value / type row with a lazy expand toggle, like the hover. */
  private variableRow(node: DebugVariableNode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "devmode-debug-variable-node";
    const row = document.createElement("div");
    row.className = "devmode-debug-variable";
    row.style.setProperty("--debug-var-depth", String(node.depth));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "devmode-debug-variable-toggle";
    toggle.disabled = !node.expandable;
    toggle.setAttribute(
      "aria-label",
      node.expandable
        ? `Expand ${node.name}`
        : `${node.name} has no children`,
    );
    if (node.expandable) {
      toggle.setAttribute("aria-expanded", "false");
      toggle.append(createLucideIcon(ChevronRight, { size: 12 }));
      toggle.addEventListener("click", () => {
        void this.toggleVariable(wrap, toggle, node);
      });
    }
    const name = document.createElement("span");
    name.className = "devmode-debug-row-main";
    name.textContent = node.name;
    const value = document.createElement("code");
    value.className = "devmode-debug-variable-value";
    value.textContent = node.value;
    value.title = node.type ? `${node.name}: ${node.type}` : node.name;
    const type = document.createElement("span");
    type.className = "devmode-debug-variable-type";
    type.textContent = node.type ?? "";
    row.append(toggle, name, value, type);
    wrap.append(row);
    return wrap;
  }

  private async toggleVariable(
    wrap: HTMLElement,
    toggle: HTMLButtonElement,
    node: DebugVariableNode,
  ): Promise<void> {
    const existing = wrap.querySelector<HTMLElement>(
      ":scope > .devmode-debug-variable-children",
    );
    if (existing) {
      existing.hidden = !existing.hidden;
      toggle.classList.toggle("is-open", !existing.hidden);
      toggle.setAttribute("aria-expanded", existing.hidden ? "false" : "true");
      return;
    }
    const children =
      (await this.onVariableExpand?.(node)) ?? [];
    if (!wrap.isConnected) return;
    const list = document.createElement("div");
    list.className = "devmode-debug-variable-children";
    for (const child of children) {
      list.append(this.variableRow(child));
    }
    if (children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "devmode-debug-variable-empty";
      empty.textContent = "No properties";
      list.append(empty);
    }
    wrap.append(list);
    toggle.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
  }

  private column(
    label: string,
    icon: DebugPanelIconName,
    content: HTMLElement,
    count: HTMLElement,
    extra?: HTMLElement,
  ): HTMLElement {
    const section = document.createElement("section");
    section.className = "devmode-debug-col";
    const head = document.createElement("div");
    head.className = "devmode-debug-col-head";
    const titleIcon = document.createElement("span");
    titleIcon.className = "devmode-debug-col-icon";
    titleIcon.append(createDebugPanelIcon(icon));
    const title = document.createElement("h3");
    title.textContent = label;
    count.className = "devmode-debug-count";
    head.append(titleIcon, title, count);
    if (extra) head.append(extra);
    section.append(head, content);
    return section;
  }

  private resizer(
    body: HTMLElement,
    left: HTMLElement,
    right: HTMLElement,
    index: number,
  ): HTMLElement {
    const handle = document.createElement("div");
    handle.className = "devmode-debug-col-resize";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "Resize debug columns");
    handle.tabIndex = 0;
    const resizeBy = (delta: number, widths?: number[]): void => {
      const columns = [
        ...body.querySelectorAll<HTMLElement>(".devmode-debug-col"),
      ];
      const current =
        widths ?? columns.map((column) => column.getBoundingClientRect().width);
      const pairWidth = current[index]! + current[index + 1]!;
      const nextLeft = Math.max(
        120,
        Math.min(pairWidth - 120, current[index]! + delta),
      );
      const next = [...current];
      next[index] = nextLeft;
      next[index + 1] = pairWidth - nextLeft;
      next.forEach((width, columnIndex) => {
        body.style.setProperty(`--debug-col-${columnIndex + 1}`, `${width}fr`);
      });
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const widths = [
        ...body.querySelectorAll<HTMLElement>(".devmode-debug-col"),
      ].map((column) => column.getBoundingClientRect().width);
      const move = (moveEvent: PointerEvent): void => {
        resizeBy(moveEvent.clientX - startX, widths);
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.root.classList.remove("is-resizing-columns");
      };
      this.root.classList.add("is-resizing-columns");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      resizeBy(event.key === "ArrowLeft" ? -16 : 16);
    });
    handle.addEventListener("dblclick", () => {
      for (let columnIndex = 1; columnIndex <= 4; columnIndex++) {
        body.style.removeProperty(`--debug-col-${columnIndex}`);
      }
    });
    // Explicit references document which pair this separator controls.
    handle.dataset.left = left.className;
    handle.dataset.right = right.className;
    return handle;
  }

  private syncStopControl(): void {
    const status = this.lastSnapshot.status;
    if (status === "idle") this.stopPending = false;
    const pending = this.stopPending && status !== "idle";
    this.stopButton.classList.toggle("is-stopping", pending);
    this.stopButton.disabled = status === "idle";
    this.stopButton.setAttribute("aria-pressed", pending ? "true" : "false");
    this.stopButton.setAttribute("aria-busy", pending ? "true" : "false");
    const label = pending ? "Stopping" : "Stop";
    this.stopButton.title = label;
    this.stopButton.setAttribute("aria-label", label);
  }

  private syncStatusLabel(): void {
    const snapshot = this.lastSnapshot;
    this.status.textContent =
      this.stopPending && snapshot.status !== "idle"
        ? "Stopping"
        : snapshot.status === "stopped"
          ? `Paused · ${snapshot.stopped?.reason ?? "stopped"}`
          : snapshot.status === "building"
            ? "Building"
            : snapshot.status === "starting"
              ? "Starting"
              : snapshot.status === "running"
                ? "Running"
                : snapshot.status === "error"
                  ? "Debug error"
                  : "Not debugging";
  }

  private empty(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "devmode-debug-empty";
    el.textContent = text;
    return el;
  }

  private action(label: string, icon: DebugPanelIconName | Parameters<typeof createLucideIcon>[0]): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "devmode-debug-action";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(
      typeof icon === "string"
        ? createDebugPanelIcon(icon)
        : createLucideIcon(icon, { size: 12 }),
    );
    return button;
  }
}
