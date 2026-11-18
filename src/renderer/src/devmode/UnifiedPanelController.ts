import {
  ChevronDown,
  ChevronUp,
  Bug,
  Rocket,
  Search,
  Square,
  SquareTerminal,
  Terminal,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { Hammer } from "lucide";
import type { IconNode } from "../ui/originalIcons.js";
import { compactControlIcon } from "./compactControl.js";
import { TerminalPaneView } from "./TerminalPaneView.js";
import { BuildProblemsView } from "./BuildProblemsView.js";
import { BuildProblemsResizeController } from "./buildProblemsResize.js";
import { createBuildDiagnosticsParser, type BuildDiagnostic } from "./buildDiagnostics.js";
import {
  BUILD_PHASE_META,
  formatBuildDuration,
} from "../screens/conversation/cards/BuildStatusCardView.js";
import {
  debugConsoleContextTitle,
  debugPanelContextTitle,
  type DebugRecipe,
} from "../../../debug/debugCopy.js";

const MAX_LINES = 3000;
const TRIM_BATCH = 500;

const PANEL_HEIGHT_KEY = "jellybot.devmode.panelHeight";
export const PANEL_DEFAULT_HEIGHT = 232;
const PANEL_MIN_HEIGHT = 96;
const PANEL_EDITOR_RESERVE = 80;
const PANEL_MAX_RATIO = 0.75;

export const TASK_TABS = ["build", "deploy"] as const;
export type TaskTabId = (typeof TASK_TABS)[number];

type TaskSnapshot = {
  runId: string;
  task: string;
  command: string;
  status: string;
  exitCode: number | null;
  startedAt: number;
  durationMs: number | null;
  buffer: string;
  progress?: DevTaskProgressSnapshot | null;
};

type TaskViewState = {
  tab: HTMLButtonElement;
  view: HTMLElement;
  output: HTMLElement;
  pipEl: HTMLElement;
  task: string | null;
  label: string;
  id: string;
  runId: string | null;
  pendingLine: HTMLDivElement | null;
  command: string;
  status: string;
  exitCode: number | null;
  startedAt: number | null;
  durationMs: number | null;
  ticker: number | null;
};

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

function endLineFor(
  status: string,
  exitCode: number | null,
  durationMs: number | null,
): { text: string; ok: boolean } {
  const failed =
    status === "failed" || status === "timeout" || status === "spawn-error";
  const secs =
    durationMs !== null ? ` · ${(durationMs / 1000).toFixed(1)}s` : "";
  const label = failed
    ? status === "timeout"
      ? "timeout"
      : status === "spawn-error"
        ? "error"
        : `exit ${exitCode ?? "?"}`
    : `exit ${exitCode ?? 0}`;
  return { text: `— ${label}${secs}`, ok: !failed };
}

function readStoredPanelHeight(): number {
  try {
    const raw = localStorage.getItem(PANEL_HEIGHT_KEY);
    if (!raw) return PANEL_DEFAULT_HEIGHT;
    const n = Number(raw);
    return Number.isFinite(n) ? n : PANEL_DEFAULT_HEIGHT;
  } catch {
    return PANEL_DEFAULT_HEIGHT;
  }
}

function writeStoredPanelHeight(px: number): void {
  try {
    localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(px)));
  } catch {
  }
}

export class UnifiedPanelController {
  readonly root: HTMLElement;
  private readonly resizeHandle: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly spacerEl: HTMLElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly collapseBtn: HTMLButtonElement;
  readonly terminalView: TerminalPaneView;
  private readonly terminal: TaskViewState;
  private readonly tasks = new Map<string, TaskViewState>();
  private readonly buildProblems = new BuildProblemsView();
  private readonly buildProblemsResize = new BuildProblemsResizeController();
  private readonly buildDiagnostics = createBuildDiagnosticsParser();
  onOpenBuildDiagnostic: ((item: BuildDiagnostic, workspacePath: string) => void) | null = null;

  private active = "terminal" as string;
  private destroyed = false;
  private open = false;
  private collapsed = true;
  private workspacePath: string | null = null;
  private subscribed = false;
  private unwatchOutput: (() => void) | null = null;
  private unwatchExit: (() => void) | null = null;
  private unwatchProgress: (() => void) | null = null;
  private buildProgress: DevTaskProgressSnapshot | null = null;
  private readonly progressStrip: HTMLElement;
  private readonly progressPhase: HTMLElement;
  private readonly progressNote: HTMLElement;
  private readonly progressCounts: HTMLElement;
  private readonly progressPct: HTMLElement;
  private readonly progressEta: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly progressBar: HTMLElement;
  private terminalTyping = false;
  onOpenChange: ((open: boolean) => void) | null = null;
  onPresentedChange: ((presented: boolean) => void) | null = null;
  private deployAvailable = false;
  private debugAvailable = false;
  private debugKind: DebugRecipe | null = null;
  private debugSessionLive = false;

  private heightPx = PANEL_DEFAULT_HEIGHT;
  private dragging = false;
  private dragStartY = 0;
  private dragStartHeight = 0;
  private readonly onPointerMove = (event: PointerEvent): void =>
    this.handlePointerMove(event);
  private readonly onPointerUp = (event: PointerEvent): void =>
    this.handlePointerUp(event);

  constructor() {
    this.buildProblems.onOpen = (item) => {
      if (this.workspacePath) this.onOpenBuildDiagnostic?.(item, this.workspacePath);
    };
    this.buildProblems.onClear = () => this.clearBuild();
    this.root = document.createElement("div");
    this.root.className = "devmode-panel is-collapsed";

    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "devmode-panel-resize";
    this.resizeHandle.setAttribute("role", "separator");
    this.resizeHandle.setAttribute("aria-orientation", "horizontal");
    this.resizeHandle.setAttribute("aria-label", "Resize panel");
    this.resizeHandle.title = "Drag to resize";
    this.resizeHandle.tabIndex = 0;
    this.wireResize();

    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "devmode-panel-tabs";
    this.tabsEl.setAttribute("role", "tablist");
    this.tabsEl.setAttribute("aria-label", "Editor panel");

    this.terminal = this.makeView(
      "terminal",
      "Terminal",
      Terminal,
      null,
    );
    this.terminalView = new TerminalPaneView();
    this.terminal.view.replaceChildren(this.terminalView.root);
    for (const id of TASK_TABS) {
      this.tasks.set(
        id,
        this.makeView(
          id,
          id === "deploy" ? "Deploy" : "Build",
          id === "deploy" ? Rocket : Hammer,
          id,
        ),
      );
    }

    this.tasks.get("deploy")!.tab.hidden = true;

    this.spacerEl = document.createElement("div");
    this.spacerEl.className = "devmode-panel-tabs-spacer";

    this.stopBtn = document.createElement("button");
    this.stopBtn.type = "button";
    this.stopBtn.className = "devmode-panel-ghost is-danger";
    this.stopBtn.title = "Terminate the process group";
    this.stopBtn.append(
      createLucideIcon(Square, { size: 10, strokeWidth: 2 }),
      document.createTextNode("Stop"),
    );
    this.stopBtn.addEventListener("click", () => this.stopActive());

    this.collapseBtn = document.createElement("button");
    this.collapseBtn.type = "button";
    this.collapseBtn.className = "devmode-panel-ghost is-icon";
    this.collapseBtn.title = "Collapse panel";
    this.collapseBtn.setAttribute("aria-label", "Collapse panel");
    this.collapseBtn.append(compactControlIcon(ChevronDown));
    this.collapseBtn.addEventListener("click", () => this.setCollapsed(!this.collapsed));

    this.tabsEl.append(
      this.terminal.tab,
      this.tasks.get("build")!.tab,
      this.tasks.get("deploy")!.tab,
      this.spacerEl,
      this.stopBtn,
      this.collapseBtn,
    );

    this.progressStrip = document.createElement("div");
    this.progressStrip.className = "devmode-panel-progress";
    this.progressStrip.hidden = true;
    this.progressPhase = document.createElement("span");
    this.progressPhase.className = "devmode-panel-progress-phase";
    this.progressNote = document.createElement("span");
    this.progressNote.className = "devmode-panel-progress-note";
    this.progressCounts = document.createElement("span");
    this.progressCounts.className = "devmode-panel-progress-counts";
    this.progressBar = document.createElement("div");
    this.progressBar.className = "devmode-panel-progress-bar";
    this.progressBar.setAttribute("role", "progressbar");
    this.progressBar.setAttribute("aria-label", "Build progress");
    this.progressBar.setAttribute("aria-valuemin", "0");
    this.progressBar.setAttribute("aria-valuemax", "100");
    this.progressFill = document.createElement("div");
    this.progressFill.className = "devmode-panel-progress-bar-fill";
    this.progressBar.append(this.progressFill);
    this.progressPct = document.createElement("span");
    this.progressPct.className = "devmode-panel-progress-pct";
    this.progressEta = document.createElement("span");
    this.progressEta.className = "devmode-panel-progress-eta";
    const metrics = document.createElement("div");
    metrics.className = "devmode-panel-progress-metrics";
    metrics.append(
      this.progressCounts,
      this.progressPct,
      this.progressEta,
    );
    this.progressStrip.append(
      this.progressPhase,
      this.progressNote,
      metrics,
      this.progressBar,
    );

    this.root.append(
      this.resizeHandle,
      this.tabsEl,
      this.progressStrip,
      this.terminal.view,
      this.tasks.get("build")!.view,
      this.tasks.get("deploy")!.view,
    );
    this.applyHeight(readStoredPanelHeight(), false);
    this.resizeHandle.hidden = true;
    this.syncCollapseA11y();
    this.updateActions();
  }

  private clearBuild(): void {
    const state = this.tasks.get("build");
    if (!state) return;
    state.output.replaceChildren();
    state.pendingLine = null;
    this.buildDiagnostics.reset();
    this.buildProblems.clear();
  }

  private addStripTab(tab: HTMLElement): void {
    this.tabsEl.insertBefore(tab, this.spacerEl);
  }

  get statusHost(): HTMLElement {
    return this.spacerEl;
  }

  installDebugView(root: HTMLElement): void {
    if (this.tasks.has("debug")) return;
    const state = this.makeView("debug", "Debug", Bug, null);
    state.view.replaceChildren(root);
    this.tasks.set("debug", state);
    this.addStripTab(state.tab);
    this.root.append(state.view);
    this.applyDebugTitles();
    this.applyDebugVisibility();
  }

  installDebugConsoleView(root: HTMLElement): void {
    if (this.tasks.has("debug-console")) return;
    const state = this.makeView(
      "debug-console",
      "Debug Console",
      SquareTerminal,
      null,
    );
    state.view.replaceChildren(root);
    this.tasks.set("debug-console", state);
    this.addStripTab(state.tab);
    this.root.append(state.view);
    this.applyDebugTitles();
    this.applyDebugVisibility();
  }

  installReferencesView(root: HTMLElement): void {
    if (this.tasks.has("references")) return;
    const state = this.makeView("references", "References", Search, null);
    state.view.replaceChildren(root);
    this.tasks.set("references", state);
    this.addStripTab(state.tab);
    this.root.append(state.view);
  }

  revealReferences(): void {
    if (this.tasks.has("references")) this.show("references");
  }

  setDebugAvailable(
    available: boolean,
    kind: DebugRecipe | null = null,
  ): void {
    const same = this.debugAvailable === available && this.debugKind === kind;
    this.debugAvailable = available;
    this.debugKind = kind;
    if (same) return;
    this.applyDebugVisibility();
    this.applyDebugTitles();
    this.updateActions();
  }

  setDeployAvailable(available: boolean): void {
    const state = this.tasks.get("deploy")!;
    this.deployAvailable = available;
    this.syncDeployVisibility();
    if (available && this.workspacePath) void this.adoptActiveRun(state);
  }

  setDebugSessionLive(live: boolean): void {
    if (this.debugSessionLive === live) return;
    this.debugSessionLive = live;
    this.applyDebugVisibility();
    this.updateActions();
  }

  private syncDeployVisibility(): void {
    const state = this.tasks.get("deploy")!;
    state.tab.hidden = !this.deployAvailable && state.runId === null;
    if (state.tab.hidden && this.active === "deploy") this.activate("terminal");
  }

  revealDebug(): void {
    if (!this.debugAvailable && !this.debugSessionLive) return;
    if (this.tasks.has("debug")) this.show("debug");
  }

  revealDebugConsole(): void {
    if (!this.debugAvailable) return;
    if (this.tasks.has("debug-console")) this.show("debug-console");
  }

  private applyDebugVisibility(): void {
    for (const id of ["debug", "debug-console"] as const) {
      const state = this.tasks.get(id);
      if (!state) continue;
      const visible = this.debugAvailable || this.debugSessionLive;
      state.tab.hidden = !visible;
      if (!visible) state.view.hidden = true;
    }
    if (
      !this.debugAvailable &&
      !this.debugSessionLive &&
      (this.active === "debug" || this.active === "debug-console")
    ) {
      this.activate("terminal");
    }
  }

  private makeView(
    id: string,
    label: string,
    icon: IconNode,
    task: string | null,
  ): TaskViewState {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "devmode-panel-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(id === this.active));
    tab.setAttribute("aria-label", label);
    tab.title = label;
    tab.append(createLucideIcon(icon, { size: 12, strokeWidth: 2 }));
    const tabLabel = document.createElement("span");
    tabLabel.className = "devmode-panel-tab-label";
    tabLabel.textContent = label;
    tab.append(tabLabel);

    const pipEl = document.createElement("span");
    pipEl.className = "devmode-panel-pip";
    if (task) tab.append(pipEl);

    const view = document.createElement("div");
    view.className =
      task === null ? "devmode-panel-term" : "devmode-panel-view";
    view.setAttribute("role", "tabpanel");
    view.hidden = id !== this.active;
    let output = view;
    if (task === "build") {
      view.classList.add("devmode-panel-build");
      output = document.createElement("div");
      output.className = "devmode-panel-build-output";
      output.setAttribute("role", "region");
      output.setAttribute("aria-label", "Build output");
      view.append(
        this.buildProblems.root,
        this.buildProblemsResize.handle,
        output,
      );
      this.buildProblemsResize.mount(view, this.buildProblems.root);
    }

    tab.addEventListener("click", () => this.show(id));
    return {
      tab,
      view,
      output,
      pipEl,
      task,
      label,
      id,
      runId: null,
      pendingLine: null,
      command: "",
      status: "idle",
      exitCode: null,
      startedAt: null,
      durationMs: null,
      ticker: null,
    };
  }

  mount(host: HTMLElement): void {
    if (!this.root.isConnected) host.append(this.root);
    this.applyHeight(this.heightPx, false);
    if (this.subscribed) return;
    const bridge = window.jellybot;
    if (!bridge?.onDevTaskOutput || !bridge.onDevTaskExit) return;
    this.subscribed = true;
    if (bridge.onDevTaskProgress) {
      this.unwatchProgress = bridge.onDevTaskProgress((payload) => {
        if (!this.workspacePath || payload.task !== "build") return;
        if (norm(payload.workspacePath) !== norm(this.workspacePath)) return;
        const build = this.tasks.get("build");
        if (!build || build.runId !== payload.runId) return;
        this.buildProgress = payload;
        this.renderBuildProgress();
      });
    }
    this.unwatchOutput = bridge.onDevTaskOutput((payload) => {
      if (!this.workspacePath) return;
      if (norm(payload.workspacePath) !== norm(this.workspacePath)) return;
      let state = this.stateForTask(payload.task);
      if (!state) return;
      if (payload.runId !== state.runId) {
        this.beginRun(state, payload.runId, payload.task);
      }
      this.appendChunk(state, payload.text, payload.stream);
      this.autoswitchToRunningTask(state);
    });
    this.unwatchExit = bridge.onDevTaskExit((snap) => {
      if (!this.workspacePath) return;
      if (norm(snap.workspacePath) !== norm(this.workspacePath)) return;
      const state = this.stateForTask(snap.task);
      if (!state || snap.runId !== state.runId) return;
      this.applyExit(state, snap);
    });
    const input = this.terminalView.input;
    input.addEventListener("focus", () => {
      this.terminalTyping = true;
    });
    input.addEventListener("blur", () => {
      this.terminalTyping = false;
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const [, state] of this.allStates()) {
      this.stopTicker(state);
      state.tab.remove();
      state.view.remove();
    }
    this.unwatchOutput?.();
    this.unwatchOutput = null;
    this.unwatchExit?.();
    this.unwatchExit = null;
    this.unwatchProgress?.();
    this.unwatchProgress = null;
    this.subscribed = false;
    this.teardownDrag();
    this.buildProblemsResize.destroy();
    this.root.remove();
  }


  private stateForTask(task: string): TaskViewState | null {
    if (task === "run" && !this.tasks.has(task)) {
      const state = this.makeView("run", "Run", SquareTerminal, "run");
      this.tasks.set("run", state);
      this.addStripTab(state.tab);
      this.root.append(state.view);
    }
    return this.tasks.get(task) ?? null;
  }

  private stateForActive(): TaskViewState | null {
    return this.active === "terminal"
      ? this.terminal
      : this.stateForTask(this.active);
  }


  isOpen(): boolean {
    return this.open;
  }

  revealTerminal(focusInput = true): void {
    this.show("terminal");
    if (focusInput) this.terminalView.focusInput();
  }

  revealForTask(task: string): void {
    this.stateForTask(task);
    const tab = this.tasks.has(task) ? task : "terminal";
    const state = this.tasks.get(task);
    if (state && state.status === "idle") {
      state.status = "waiting";
      state.command = "";
      state.output.replaceChildren(
        this.lineEl("Waiting for output…", "is-dim"),
      );
      state.pendingLine = null;
    }
    if (state) void this.adoptActiveRun(state);
    this.show(tab);
  }

  private async adoptActiveRun(state: TaskViewState): Promise<void> {
    const bridge = window.jellybot;
    const ws = this.workspacePath;
    const task = state.task;
    if (!bridge?.getDevTaskState || !ws || !task) return;
    if (state.status === "running" && state.runId) return;
    let active;
    try {
      const snapshot = await bridge.getDevTaskState(ws);
      if (ws !== this.workspacePath) return;
      active = snapshot.active.find((r) => r.task === task);
    } catch {
      return;
    }
    if (!active || active.runId === state.runId) return;
    this.attachRun(state, active);
  }

  private show(tab: string): void {
    this.open = true;
    this.root.hidden = false;
    this.collapsed = false;
    this.root.classList.remove("is-collapsed");
    this.resizeHandle.hidden = false;
    this.syncCollapseA11y();
    this.applyHeight(this.heightPx, false);
    this.activate(tab);
    this.onOpenChange?.(true);
    this.onPresentedChange?.(true);
  }

  hide(): void {
    if (!this.open) return;
    this.teardownDrag();
    this.open = false;
    this.collapsed = true;
    this.root.classList.add("is-collapsed");
    this.resizeHandle.hidden = true;
    this.syncCollapseA11y();
    this.updateActions();
    this.onOpenChange?.(false);
    this.onPresentedChange?.(false);
  }

  private setCollapsed(collapsed: boolean): void {
    if (!collapsed && !this.open) {
      this.show(this.active);
      return;
    }
    if (this.collapsed === collapsed) return;
    this.teardownDrag();
    this.collapsed = collapsed;
    this.root.classList.toggle("is-collapsed", collapsed);
    this.resizeHandle.hidden = collapsed;
    this.syncCollapseA11y();
    this.updateActions();
    this.onPresentedChange?.(this.open && !collapsed);
  }

  private syncCollapseA11y(): void {
    this.collapseBtn.title = this.collapsed ? "Expand panel" : "Collapse panel";
    this.collapseBtn.setAttribute(
      "aria-label",
      this.collapsed ? "Expand panel" : "Collapse panel",
    );
    this.collapseBtn.setAttribute("aria-expanded", String(!this.collapsed));
    this.collapseBtn.replaceChildren(
      compactControlIcon(this.collapsed ? ChevronUp : ChevronDown),
    );
  }


  private wireResize(): void {
    this.resizeHandle.setAttribute("aria-valuemin", String(PANEL_MIN_HEIGHT));
    this.resizeHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (this.collapsed || this.resizeHandle.hidden) return;
      event.preventDefault();
      this.dragging = true;
      this.dragStartY = event.clientY;
      this.dragStartHeight = this.heightPx;
      this.root.classList.add("is-resizing");
      this.resizeHandle.classList.add("is-dragging");
      try {
        this.resizeHandle.setPointerCapture(event.pointerId);
      } catch {
      }
      window.addEventListener("pointermove", this.onPointerMove);
      window.addEventListener("pointerup", this.onPointerUp);
      window.addEventListener("pointercancel", this.onPointerUp);
    });
    this.resizeHandle.addEventListener("keydown", (event) => {
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
        this.applyHeight(PANEL_DEFAULT_HEIGHT, true);
      }
    });
    this.resizeHandle.addEventListener("dblclick", () => {
      if (this.collapsed) return;
      this.applyHeight(PANEL_DEFAULT_HEIGHT, true);
    });
  }

  private parentHeight(): number {
    const parent = this.root.parentElement;
    if (!parent) return 0;
    return parent.getBoundingClientRect().height;
  }

  private clampHeight(px: number): number {
    const parentH = this.parentHeight();
    let max = Math.round(4096);
    if (parentH > 0) {
      max = Math.max(
        PANEL_MIN_HEIGHT,
        Math.min(
          Math.round(parentH * PANEL_MAX_RATIO),
          parentH - PANEL_EDITOR_RESERVE,
        ),
      );
    }
    return Math.min(max, Math.max(PANEL_MIN_HEIGHT, Math.round(px)));
  }

  private applyHeight(px: number, persist: boolean): void {
    this.heightPx = this.clampHeight(px);
    this.root.style.setProperty("--devmode-panel-height", `${this.heightPx}px`);
    this.resizeHandle.setAttribute("aria-valuenow", String(this.heightPx));
    this.resizeHandle.setAttribute("aria-valuemax", String(
      this.parentHeight() > 0
        ? Math.max(
            PANEL_MIN_HEIGHT,
            Math.min(
              Math.round(this.parentHeight() * PANEL_MAX_RATIO),
              this.parentHeight() - PANEL_EDITOR_RESERVE,
            ),
          )
        : PANEL_DEFAULT_HEIGHT,
    ));
    if (persist) writeStoredPanelHeight(this.heightPx);
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    const next = this.dragStartHeight + (this.dragStartY - event.clientY);
    this.applyHeight(next, false);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    try {
      this.resizeHandle.releasePointerCapture(event.pointerId);
    } catch {
    }
    this.teardownDrag();
    writeStoredPanelHeight(this.heightPx);
  }

  private teardownDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.root.classList.remove("is-resizing");
    this.resizeHandle.classList.remove("is-dragging");
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
  }

  private activate(tab: string): void {
    this.active = tab;
    for (const [id, state] of this.allStates()) {
      const isOn = id === tab;
      state.tab.classList.toggle("is-on", isOn);
      state.tab.setAttribute("aria-selected", String(isOn));
      state.view.hidden = !isOn;
    }
    this.updateActions();
    this.renderBuildProgress();
    const activated = this.tasks.get(tab);
    if (activated?.task && activated.status !== "running") {
      void this.adoptActiveRun(activated);
    }
  }

  private renderBuildProgress(): void {
    const build = this.tasks.get("build");
    const show =
      this.active === "build" &&
      build?.status === "running" &&
      this.buildProgress != null;
    this.progressStrip.hidden = !show;
    this.placeStopButton(show);
    this.progressStrip.classList.toggle("is-indeterminate", false);
    const p = this.buildProgress;
    if (!show || !p) return;
    const meta = BUILD_PHASE_META[p.phase] ?? BUILD_PHASE_META.analyzing!;
    this.progressPhase.textContent = meta.label;
    this.progressBar.setAttribute("aria-label", meta.label);
    if (
      meta.determinate &&
      p.doneActions != null &&
      p.totalActions != null &&
      p.totalActions > 0
    ) {
      const ratio = Math.min(1, Math.max(0, p.doneActions / p.totalActions));
      const pct = Math.floor(ratio * 100);
      this.progressNote.textContent = "";
      this.progressCounts.textContent = `${p.doneActions.toLocaleString("en-US")} / ${p.totalActions.toLocaleString("en-US")}`;
      this.progressPct.textContent = `${pct}%`;
      this.progressBar.setAttribute("aria-valuenow", String(pct));
      this.progressFill.classList.remove("indeterminate");
      this.progressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    } else {
      this.progressStrip.classList.add("is-indeterminate");
      this.progressNote.textContent =
        p.phase === "analyzing"
          ? "Preparing build targets…"
          : p.phase === "generating"
            ? "UnrealHeaderTool"
            : "";
      this.progressCounts.textContent = "";
      this.progressPct.textContent = "";
      this.progressBar.removeAttribute("aria-valuenow");
      this.progressFill.classList.add("indeterminate");
      this.progressFill.style.width = "0%";
    }
    this.progressEta.textContent =
      p.etaMs != null && p.phase !== "linking"
        ? `≈${formatBuildDuration(p.etaMs)}`
        : "";
  }

  private placeStopButton(inProgressRow: boolean): void {
    if (inProgressRow) {
      if (this.stopBtn.parentElement !== this.progressStrip) {
        this.progressStrip.insertBefore(this.stopBtn, this.progressBar);
      }
    } else if (this.stopBtn.parentElement !== this.tabsEl) {
      this.tabsEl.insertBefore(this.stopBtn, this.collapseBtn);
    }
  }

  private *allStates(): Generator<[string, TaskViewState]> {
    yield ["terminal", this.terminal];
    for (const [id, s] of this.tasks) yield [id, s];
  }


  setWorkspace(path: string | null): void {
    if (this.destroyed) return;
    if (path !== this.workspacePath) {
      const run = this.tasks.get("run");
      if (run) {
        this.stopTicker(run); run.tab.remove(); run.view.remove(); this.tasks.delete("run");
        if (this.active === "run") this.activate("terminal");
      }
      this.deployAvailable = false;
      this.resetState(this.tasks.get("deploy")!);
      this.syncDeployVisibility();
    }
    this.workspacePath = path;
    if (!path) {
      for (const [id, state] of this.allStates()) {
        if (id !== "debug" && id !== "debug-console") this.resetState(state);
      }
      return;
    }
    void this.replay();
  }

  ensureWorkspace(path: string | null): void {
    if (path === null) {
      if (this.workspacePath !== null) this.setWorkspace(null);
      return;
    }
    if (norm(path) === norm(this.workspacePath ?? "")) return;
    this.setWorkspace(path);
  }

  private async replay(): Promise<void> {
    if (this.destroyed) return;
    const bridge = window.jellybot;
    const ws = this.workspacePath;
    if (!bridge || !ws) return;
    let state;
    try {
      state = await bridge.getDevTaskState(ws);
    } catch {
      return;
    }
    if (this.destroyed || ws !== this.workspacePath) return;
    let newestRunning: TaskViewState | null = null;
    for (const id of [...TASK_TABS, "run"]) {
      const running = state.active.find((r) => r.task === id);
      const snapshot = running ?? state.last[id] ?? null;
      const view = id === "run" && snapshot ? this.stateForTask(id)! : this.tasks.get(id);
      if (!view) continue;
      if (snapshot) this.attachRun(view, snapshot);
      else this.resetState(view);
      if (
        running && !view.tab.hidden &&
        (!newestRunning ||
          running.startedAt > (newestRunning.startedAt ?? 0))
      ) {
        newestRunning = view;
      }
    }
    if (newestRunning && !this.open) this.show(newestRunning.task!);
  }


  private updateActions(): void {
    if (this.active === "terminal") {
      this.stopBtn.hidden = !this.terminalView.busy;
    } else if (this.active === "debug") {
      this.stopBtn.hidden = true;
    } else if (this.active === "debug-console" || this.active === "references") {
      this.stopBtn.hidden = true;
    } else {
      const state = this.stateForActive();
      this.stopBtn.hidden = state?.status !== "running";
    }
    if (this.collapsed) this.stopBtn.hidden = true;
  }

  private setTabTitle(state: TaskViewState): void {
    const bits: string[] = [state.label];
    if (state.command) bits.push(state.command);
    const secs =
      state.durationMs !== null
        ? `${(state.durationMs / 1000).toFixed(1)}s`
        : state.startedAt !== null
          ? `${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`
          : "";
    if (state.status === "running") {
      if (secs) bits.push(`running ${secs}`);
    } else if (state.status === "done" || state.status === "failed") {
      bits.push(`exit ${state.exitCode ?? "?"}${secs ? ` · ${secs}` : ""}`);
    } else if (state.status === "timeout") {
      bits.push(`timeout${secs ? ` · ${secs}` : ""}`);
    } else if (state.status === "spawn-error") {
      bits.push("error");
    }
    state.tab.title = bits.join(" · ");
    if (state.task === "deploy") this.syncDeployVisibility();
  }

  private applyDebugTitles(): void {
    const dbg = this.tasks.get("debug");
    if (dbg) dbg.tab.title = debugPanelContextTitle(this.debugKind);
    const con = this.tasks.get("debug-console");
    if (con) con.tab.title = debugConsoleContextTitle(this.debugKind);
  }

  private appendEndLine(
    state: TaskViewState,
    text: string,
    ok: boolean,
  ): void {
    const el = this.lineEl(text);
    el.classList.add(ok ? "is-end-ok" : "is-end-bad");
    state.output.append(el);
    state.pendingLine = null;
  }


  private stopActive(): void {
    if (this.active === "terminal") {
      this.terminalControllerStop?.();
      return;
    }
    const bridge = window.jellybot;
    const state = this.stateForActive();
    if (!bridge || !state?.runId) return;
    void bridge.stopDevTask(state.runId).catch(() => undefined);
  }

  terminalControllerStop: (() => void) | null = null;


  private beginRun(
    state: TaskViewState,
    runId: string,
    task: string,
  ): void {
    state.runId = runId;
    state.command = "";
    state.status = "running";
    state.exitCode = null;
    state.startedAt = Date.now();
    state.durationMs = null;
    state.pendingLine = null;
    state.output.replaceChildren();
    this.setPip(state, "running");
    this.startTicker(state);
    this.setTabTitle(state);
    this.updateActions();
    if (state.task === "build") {
      this.buildDiagnostics.reset();
      this.buildProblems.clear();
      this.buildProgress = null;
      this.renderBuildProgress();
    }
  }

  private attachRun(state: TaskViewState, run: TaskSnapshot): void {
    this.stopTicker(state);
    state.runId = run.runId;
    state.command = run.command;
    state.status = run.status;
    state.exitCode = run.exitCode;
    state.startedAt = run.startedAt;
    state.durationMs = run.durationMs;
    state.pendingLine = null;
    state.output.replaceChildren();
    for (const line of run.buffer.split("\n")) {
      if (line || run.buffer.endsWith("\n")) {
        state.output.append(this.lineEl(line === "" ? " " : line));
      }
    }
    if (run.buffer && !run.buffer.endsWith("\n")) {
      const lines = state.output.children;
      const last = lines[lines.length - 1];
      if (last instanceof HTMLDivElement) state.pendingLine = last;
    }
    this.trimLines(state);
    if (run.status !== "running") {
      const end = endLineFor(run.status, run.exitCode, run.durationMs);
      this.appendEndLine(state, end.text, end.ok);
    }
    this.setPip(
      state,
      run.status === "running"
        ? "running"
        : run.status === "done" && run.exitCode === 0
          ? "ok"
          : run.status === "failed" || run.status === "timeout" || run.status === "spawn-error"
            ? "failed"
            : "none",
    );
    if (run.status === "running") this.startTicker(state);
    if (state.task === "build") {
      this.buildDiagnostics.reset();
      this.buildProblems.clear();
      this.buildProblems.append(this.buildDiagnostics.feed(run.buffer));
      if (run.status !== "running") this.buildProblems.append(this.buildDiagnostics.flush());
      this.buildProgress = run.progress ?? null;
      this.renderBuildProgress();
    }
    this.setTabTitle(state);
    this.updateActions();
  }

  private applyExit(state: TaskViewState, snap: TaskSnapshot): void {
    this.stopTicker(state);
    state.status = snap.status;
    state.exitCode = snap.exitCode;
    state.durationMs = snap.durationMs;
    state.pendingLine = null;
    if (state.task === "build") {
      this.buildProblems.append(this.buildDiagnostics.flush());
      this.buildProgress = null;
      this.renderBuildProgress();
    }
    const failed =
      snap.status === "failed" ||
      snap.status === "timeout" ||
      snap.status === "spawn-error";
    this.setPip(state, failed ? "failed" : "ok");
    const end = endLineFor(snap.status, snap.exitCode, snap.durationMs);
    this.appendEndLine(state, end.text, end.ok);
    this.setTabTitle(state);
    this.updateActions();
  }

  private resetState(state: TaskViewState): void {
    this.stopTicker(state);
    state.runId = null;
    state.command = "";
    state.status = "idle";
    state.exitCode = null;
    state.startedAt = null;
    state.durationMs = null;
    state.pendingLine = null;
    state.output.replaceChildren();
    if (state.task === "build") {
      this.buildDiagnostics.reset();
      this.buildProblems.clear();
      this.buildProgress = null;
      this.renderBuildProgress();
    }
    this.setPip(state, "none");
    this.setTabTitle(state);
    this.updateActions();
  }

  private setPip(state: TaskViewState, kind: string): void {
    state.pipEl.className = `devmode-panel-pip is-${kind}`;
  }

  private autoswitchToRunningTask(state: TaskViewState): void {
    if (state.status !== "running") return;
    if (this.active === state.task && this.open) return;
    if (this.terminalTyping && this.open) return;
    this.show(state.task!);
  }

  private appendChunk(
    state: TaskViewState,
    text: string,
    stream: "stdout" | "stderr",
  ): void {
    if (!text) return;
    if (state.task === "build") {
      this.buildProblems.append(this.buildDiagnostics.feed(text, stream));
    }
    const normalized = text.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.includes("\r")) {
        const segs = part.split("\r");
        let shown = "";
        for (let s = segs.length - 1; s >= 0; s--) {
          if (segs[s]) {
            shown = segs[s]!;
            break;
          }
        }
        if (shown) this.replacePending(state, shown, stream);
      } else if (part) {
        this.appendToPending(state, part, stream);
      }
      if (i !== parts.length - 1) state.pendingLine = null;
    }
    this.trimLines(state);
    this.scrollIntoView(state);
  }

  private replacePending(
    state: TaskViewState,
    text: string,
    stream: "stdout" | "stderr",
  ): void {
    if (state.pendingLine) {
      state.pendingLine.replaceChildren();
      state.pendingLine.dataset.stream = stream;
      if (stream === "stderr") state.pendingLine.classList.add("is-err");
      else state.pendingLine.classList.remove("is-err");
    }
    if (text) this.appendToPending(state, text, stream);
    else if (state.pendingLine) state.pendingLine = null;
  }

  private appendToPending(
    state: TaskViewState,
    text: string,
    stream: "stdout" | "stderr",
  ): void {
    if (
      state.pendingLine &&
      state.pendingLine.dataset.stream !== stream
    ) {
      state.pendingLine = null;
    }
    if (!state.pendingLine) {
      state.pendingLine = this.lineEl("", stream);
      state.output.append(state.pendingLine);
    }
    state.pendingLine.append(document.createTextNode(text));
  }

  private lineEl(
    text: string,
    stream?: "stdout" | "stderr" | "is-dim",
  ): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "devmode-panel-line";
    if (stream === "stderr") el.classList.add("is-err");
    else if (stream === "is-dim") el.classList.add("is-dim");
    else if (stream) el.dataset.stream = stream;
    if (text) el.textContent = text;
    return el;
  }

  private trimLines(state: TaskViewState): void {
    const count = state.output.childElementCount;
    if (count <= MAX_LINES) return;
    for (let i = 0; i < TRIM_BATCH && state.output.firstElementChild; i++) {
      if (state.output.firstElementChild === state.pendingLine) break;
      state.output.firstElementChild.remove();
    }
  }

  private startTicker(state: TaskViewState): void {
    this.stopTicker(state);
    if (state.startedAt === null) return;
    const startedAt = state.startedAt;
    const update = (): void => {
      this.setTabTitle(state);
    };
    update();
    state.ticker = window.setInterval(update, 500);
  }

  private stopTicker(state: TaskViewState): void {
    if (state.ticker !== null) window.clearInterval(state.ticker);
    state.ticker = null;
  }

  private scrollIntoView(state: TaskViewState): void {
    if (this.collapsed) return;
    state.output.scrollTop = state.output.scrollHeight;
  }
}
