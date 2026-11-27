import {
  ChevronDown,
  ChevronUp,
  Bug,
  Search,
  Square,
  SquareTerminal,
  Terminal,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { Hammer } from "lucide";
import { PRE_BUILD_TASK_ID } from "../../../shared/devTaskIds.js";
import type { IconNode } from "../ui/originalIcons.js";
import { compactControlIcon } from "./compactControl.js";
import { TerminalPaneView } from "./TerminalPaneView.js";
import type { LineSink, LiveLine } from "./chunkLog.js";
import { BuildLogModel } from "./buildLogModel.js";
import { BuildOutputView } from "./BuildOutputView.js";
import { BuildProblemsView } from "./BuildProblemsView.js";
import { BuildProblemsResizeController } from "./buildProblemsResize.js";
import { buildOutputTone, createBuildDiagnosticsParser, stripBuildAnsi, type BuildDiagnostic } from "./buildDiagnostics.js";
import {
  BUILD_PHASE_META,
  formatBuildDuration,
} from "../screens/conversation/cards/BuildStatusCardView.js";
import {
  debugConsoleContextTitle,
  debugPanelContextTitle,
  type DebugRecipe,
} from "../../../debug/debugCopy.js";

const PANEL_HEIGHT_KEY = "jellybot.devmode.panelHeight";
export const PANEL_DEFAULT_HEIGHT = 232;
const PANEL_MIN_HEIGHT = 96;
const PANEL_EDITOR_RESERVE = 80;
const PANEL_MAX_RATIO = 0.75;
const MAX_PRINTED_RUNS = 64;

/** Tasks whose output belongs to the Terminal; everything else lands in Build. */
const TERMINAL_TASKS = new Set(["run", "deploy"]);

export const BUILD_TAB = "build";

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

type TabState = {
  tab: HTMLButtonElement;
  view: HTMLElement;
  label: string;
  id: string;
  pipEl: HTMLElement | null;
};

type TaskRun = {
  task: string;
  runId: string;
  command: string;
  status: string;
  exitCode: number | null;
  startedAt: number | null;
  durationMs: number | null;
  sink: LineSink;
  live: LiveLine | null;
  liveText: string;
  liveStream: "stdout" | "stderr";
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
  const label = status === "cancelled" ? "cancelled"
    : status === "timeout" ? "timeout"
    : status === "spawn-error" ? "error"
    : `exit ${exitCode ?? (failed ? "?" : 0)}`;
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
  private readonly terminal: TabState;
  private readonly build: TabState;
  private readonly buildLog = new BuildLogModel();
  private readonly buildOutput = new BuildOutputView(this.buildLog);
  private readonly tabs = new Map<string, TabState>();
  private readonly runs = new Map<string, TaskRun>();
  private readonly printed = new Map<string, { chars: number; surface: string }>();
  private taskCommands = new Map<string, string>();
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
    this.buildProblems.onClear = () => this.clearProblems();
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

    this.terminal = this.makeTab("terminal", "Terminal", Terminal, true);
    this.terminalView = new TerminalPaneView();
    this.terminal.view.replaceChildren(this.terminalView.root);
    this.tabs.set("terminal", this.terminal);

    this.build = this.makeTab(BUILD_TAB, "Build", Hammer, true);
    this.build.view.classList.add("devmode-panel-build");
    this.build.view.replaceChildren(
      this.buildProblems.root,
      this.buildProblemsResize.handle,
      this.buildOutput.root,
    );
    this.buildProblemsResize.mount(this.build.view, this.buildProblems.root);
    this.tabs.set(BUILD_TAB, this.build);

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
      this.build.tab,
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
      this.build.view,
    );
    this.applyHeight(readStoredPanelHeight(), false);
    this.resizeHandle.hidden = true;
    this.syncCollapseA11y();
    this.updateActions();
  }

  private clearProblems(): void {
    this.buildLog.clear();
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
    if (this.tabs.has("debug")) return;
    const state = this.makeTab("debug", "Debug", Bug, false);
    state.view.classList.add("devmode-panel-debug");
    state.view.replaceChildren(root);
    this.tabs.set("debug", state);
    this.addStripTab(state.tab);
    this.root.append(state.view);
    this.applyDebugTitles();
    this.applyDebugVisibility();
  }

  installDebugConsoleView(root: HTMLElement): void {
    if (this.tabs.has("debug-console")) return;
    const state = this.makeTab("debug-console", "Debug Console", SquareTerminal, false);
    state.view.classList.add("devmode-panel-debug-console");
    state.view.replaceChildren(root);
    this.tabs.set("debug-console", state);
    this.addStripTab(state.tab);
    this.root.append(state.view);
    this.applyDebugTitles();
    this.applyDebugVisibility();
  }

  installReferencesView(root: HTMLElement): void {
    if (this.tabs.has("references")) return;
    const state = this.makeTab("references", "References", Search, false);
    state.view.classList.add("devmode-panel-references");
    state.view.replaceChildren(root);
    this.tabs.set("references", state);
    this.addStripTab(state.tab);
    this.root.append(state.view);
  }

  revealReferences(): void {
    if (this.tabs.has("references")) this.show("references");
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
    const was = this.deployAvailable;
    this.deployAvailable = available;
    if (available && !was && this.workspacePath) void this.adoptTask("deploy");
  }

  setDebugSessionLive(live: boolean): void {
    if (this.debugSessionLive === live) return;
    this.debugSessionLive = live;
    this.applyDebugVisibility();
    this.updateActions();
  }

  revealDebug(): void {
    if (!this.debugAvailable && !this.debugSessionLive) return;
    if (this.tabs.has("debug")) this.show("debug");
  }

  revealDebugConsole(): void {
    if (!this.debugAvailable) return;
    if (this.tabs.has("debug-console")) this.show("debug-console");
  }

  private applyDebugVisibility(): void {
    for (const id of ["debug", "debug-console"] as const) {
      const state = this.tabs.get(id);
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

  private makeTab(
    id: string,
    label: string,
    icon: IconNode,
    withPip: boolean,
  ): TabState {
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

    let pipEl: HTMLElement | null = null;
    if (withPip) {
      pipEl = document.createElement("span");
      pipEl.className = "devmode-panel-pip";
      pipEl.setAttribute("aria-hidden", "true");
      tab.append(pipEl);
    }

    const view = document.createElement("div");
    view.className =
      id === "terminal" ? "devmode-panel-term" : "devmode-panel-view";
    view.setAttribute("role", "tabpanel");
    view.hidden = id !== this.active;

    tab.addEventListener("click", () => this.show(id));
    return { tab, view, label, id, pipEl };
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
        const build = this.runs.get("build");
        if (!build || build.runId !== payload.runId) return;
        this.buildProgress = payload;
        this.renderBuildProgress();
      });
    }
    this.unwatchOutput = bridge.onDevTaskOutput((payload) => {
      if (!this.workspacePath) return;
      if (norm(payload.workspacePath) !== norm(this.workspacePath)) return;
      const run = this.runFor(payload.task);
      if (payload.runId !== run.runId) this.beginRun(run, payload.runId, payload.command);
      const stream = payload.stream === "stderr" ? "stderr" : "stdout";
      if (this.feedsProblems(run.task)) {
        this.buildProblems.append(this.buildDiagnostics.feed(payload.text, this.diagnosticsChannel(run.runId, stream)));
      }
      this.writeRunText(run, payload.text, stream);
      this.notePrinted(run.runId, payload.text.length);
      this.revealRunningRun(run);
    });
    this.unwatchExit = bridge.onDevTaskExit((snap) => {
      if (!this.workspacePath) return;
      if (norm(snap.workspacePath) !== norm(this.workspacePath)) return;
      const run = this.runFor(snap.task);
      if (snap.runId !== run.runId) {
        if (run.runId && (run.startedAt ?? 0) > snap.startedAt) return;
        run.runId = snap.runId;
        run.command = snap.command || run.command;
        this.printRunHead(run);
      }
      this.applyExit(run, snap);
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
    this.buildProblems.destroy();
    this.buildOutput.destroy();
    this.root.remove();
  }

  isOpen(): boolean {
    return this.open;
  }

  revealTerminal(focusInput = true): void {
    this.show("terminal");
    if (focusInput) this.terminalView.focusInput();
  }

  revealForTask(task: string): void {
    this.show(this.surfaceTab(task));
    void this.adoptTask(task);
  }

  /** Build-ish tasks (build, lint, any custom check) share the Build panel. */
  private surfaceTab(task: string): string {
    return TERMINAL_TASKS.has(task) ? "terminal" : BUILD_TAB;
  }

  private sinkFor(task: string): LineSink {
    return TERMINAL_TASKS.has(task) ? this.terminalView.log : this.buildLog;
  }

  private feedsProblems(task: string): boolean {
    return !TERMINAL_TASKS.has(task);
  }

  private diagnosticsChannel(runId: string, stream = "stdout"): string {
    return `${runId}|${stream}`;
  }

  private async adoptTask(task: string): Promise<void> {
    const bridge = window.jellybot;
    const ws = this.workspacePath;
    if (!bridge?.getDevTaskState || !ws) return;
    const current = this.runs.get(task);
    if (current?.status === "running" && current.runId) return;
    let snapshot;
    try {
      snapshot = await bridge.getDevTaskState(ws);
    } catch {
      return;
    }
    if (ws !== this.workspacePath) return;
    const active = snapshot.active.find((r) => r.task === task);
    if (active) {
      this.attachRun(this.runFor(task), active);
      return;
    }
    const last = snapshot.last?.[task];
    if (last) this.restoreProblems(task, last);
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
  }

  private renderBuildProgress(): void {
    const build = this.runs.get("build");
    const show =
      this.active === BUILD_TAB &&
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

  private *allStates(): Generator<[string, TabState]> {
    yield ["terminal", this.terminal];
    for (const [id, s] of this.tabs) {
      if (id === "terminal") continue;
      yield [id, s];
    }
  }

  setWorkspace(path: string | null): void {
    if (this.destroyed) return;
    if (path !== this.workspacePath) {
      this.resetRuns();
      this.deployAvailable = false;
      this.clearProblems();
    }
    this.workspacePath = path;
    if (!path) {
      this.resetRuns();
      return;
    }
    void this.loadTaskCommands();
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

  private async loadTaskCommands(): Promise<void> {
    const bridge = window.jellybot;
    const ws = this.workspacePath;
    if (!bridge?.getDevTaskConfig || !ws) return;
    let tasks: Array<{ id: string; command: string }> = [];
    try {
      const res = await bridge.getDevTaskConfig(ws);
      if (res.ok) tasks = res.tasks;
    } catch {
      tasks = [];
    }
    if (ws !== this.workspacePath) return;
    this.taskCommands = new Map(tasks.map((t) => [t.id, t.command]));
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
    let newestRunning: TaskRun | null = null;
    for (const snapshot of state.active ?? []) {
      const run = this.runFor(snapshot.task);
      this.attachRun(run, snapshot);
      if (!newestRunning || (snapshot.startedAt ?? 0) > (newestRunning.startedAt ?? 0)) {
        newestRunning = run;
      }
    }
    let newestFinished: [string, TaskSnapshot] | null = null;
    for (const [task, snapshot] of Object.entries(state.last ?? {})) {
      if ((state.active ?? []).some((r) => r.task === task)) continue;
      if (task === PRE_BUILD_TASK_ID && !this.runs.has(task)) {
        this.attachRun(this.runFor(task), snapshot);
      }
      if (this.feedsProblems(task) && (!newestFinished || snapshot.startedAt > newestFinished[1].startedAt)) {
        newestFinished = [task, snapshot];
      }
    }
    const problemsRunning = (state.active ?? []).some((r) => this.feedsProblems(r.task));
    if (newestFinished && !problemsRunning) this.restoreProblems(...newestFinished);
    if (newestRunning && !this.open) this.show(this.surfaceTab(newestRunning.task));
  }

  private restoreProblems(task: string, snapshot: TaskSnapshot): void {
    if (!this.feedsProblems(task)) return;
    this.buildDiagnostics.reset();
    this.buildProblems.clear();
    const channel = this.diagnosticsChannel(snapshot.runId);
    this.buildProblems.append(this.buildDiagnostics.feed(snapshot.buffer, channel));
    if (snapshot.status !== "running") {
      this.buildProblems.append(this.buildDiagnostics.flush(channel));
    }
  }

  private updateActions(): void {
    const run = this.activeRun();
    if (this.active === "terminal") {
      this.stopBtn.hidden = !this.terminalView.busy && !run;
    } else if (
      this.active === "debug" ||
      this.active === "debug-console" ||
      this.active === "references"
    ) {
      this.stopBtn.hidden = true;
    } else {
      this.stopBtn.hidden = !run;
    }
    if (this.collapsed) this.stopBtn.hidden = true;
  }

  private applyDebugTitles(): void {
    const dbg = this.tabs.get("debug");
    if (dbg) dbg.tab.title = debugPanelContextTitle(this.debugKind);
    const con = this.tabs.get("debug-console");
    if (con) con.tab.title = debugConsoleContextTitle(this.debugKind);
  }

  private stopActive(): void {
    if (this.active === "terminal" && this.terminalView.busy) {
      this.terminalControllerStop?.();
      return;
    }
    const bridge = window.jellybot;
    const run = this.activeRun();
    if (!bridge || !run) return;
    void bridge.stopDevTask(run.runId).catch(() => undefined);
  }

  terminalControllerStop: (() => void) | null = null;

  private runFor(task: string): TaskRun {
    const existing = this.runs.get(task);
    if (existing) return existing;
    const run: TaskRun = {
      task,
      runId: "",
      command: "",
      status: "idle",
      exitCode: null,
      startedAt: null,
      durationMs: null,
      sink: this.sinkFor(task),
      live: null,
      liveText: "",
      liveStream: "stdout",
    };
    this.runs.set(task, run);
    return run;
  }

  private activeRun(): TaskRun | null {
    const running = [...this.runs.values()].filter(
      (run) =>
        run.status === "running" &&
        run.runId &&
        this.surfaceTab(run.task) === this.active,
    );
    if (!running.length) return null;
    running.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return running[0]!;
  }

  private resetRuns(): void {
    this.runs.clear();
    // The Build log is per project, so it is wiped with the runs that produced it;
    // forgetting its print ledger lets the same build replay in full when the
    // project comes back. Terminal scrollback survives, so its ledger does too.
    for (const [runId, entry] of [...this.printed]) {
      if (entry.surface === BUILD_TAB) this.printed.delete(runId);
    }
    this.buildProgress = null;
    this.buildLog.clear();
    this.renderBuildProgress();
    this.syncPips();
    this.updateActions();
  }

  private isPrinted(runId: string): boolean {
    return this.printed.has(runId);
  }

  private printedChars(runId: string): number {
    return this.printed.get(runId)?.chars ?? 0;
  }

  private markPrinted(runId: string, surface: string): void {
    if (!runId || this.printed.has(runId)) return;
    this.printed.set(runId, { chars: 0, surface });
    while (this.printed.size > MAX_PRINTED_RUNS) {
      const oldest = this.printed.keys().next();
      if (oldest.done) break;
      this.printed.delete(oldest.value);
    }
  }

  private notePrinted(runId: string, chars: number): void {
    const entry = this.printed.get(runId);
    if (!runId || chars <= 0 || !entry) return;
    entry.chars += chars;
  }

  private runLabel(run: TaskRun): string {
    return run.command || this.taskCommands.get(run.task) || run.task;
  }

  private printRunHead(run: TaskRun): void {
    if (this.isPrinted(run.runId)) return;
    const label = this.runLabel(run);
    this.markPrinted(run.runId, this.surfaceTab(run.task));
    if (!label) return;
    run.sink.appendOutput(`$ ${label}\n`, "meta");
  }

  private beginRun(run: TaskRun, runId: string, command?: string): void {
    run.runId = runId;
    run.command = command ?? this.taskCommands.get(run.task) ?? "";
    run.status = "running";
    run.exitCode = null;
    run.startedAt = Date.now();
    run.durationMs = null;
    this.resetLive(run);
    this.printRunHead(run);
    if (this.feedsProblems(run.task)) {
      this.buildDiagnostics.reset();
      this.buildProblems.clear();
    }
    if (run.task === "build") {
      this.buildProgress = null;
      this.renderBuildProgress();
    }
    this.syncPips();
    this.updateActions();
  }

  private attachRun(run: TaskRun, snapshot: TaskSnapshot): void {
    run.runId = snapshot.runId;
    run.command = snapshot.command || this.taskCommands.get(run.task) || "";
    run.status = snapshot.status;
    run.exitCode = snapshot.exitCode;
    run.startedAt = snapshot.startedAt;
    run.durationMs = snapshot.durationMs;
    if (!this.isPrinted(snapshot.runId)) {
      this.resetLive(run);
      this.printRunHead(run);
      if (snapshot.buffer) {
        this.writeRunText(run, snapshot.buffer, "stdout");
        this.notePrinted(snapshot.runId, snapshot.buffer.length);
      }
      if (run.liveText) this.commitRunLine(run);
      if (run.status !== "running") {
        this.appendEndLine(run, snapshot);
      }
    } else {
      const missing = snapshot.buffer.slice(this.printedChars(snapshot.runId));
      if (missing) {
        this.writeRunText(run, missing, "stdout");
        this.notePrinted(snapshot.runId, missing.length);
      }
    }
    if (this.feedsProblems(run.task)) {
      const channel = this.diagnosticsChannel(snapshot.runId);
      this.buildProblems.append(this.buildDiagnostics.feed(snapshot.buffer, channel));
      if (snapshot.status !== "running") {
        this.buildProblems.append(this.buildDiagnostics.flush(channel));
      }
    }
    if (run.task === "build") {
      this.buildProgress = snapshot.progress ?? null;
      this.renderBuildProgress();
    }
    this.syncPips();
    this.updateActions();
  }

  private applyExit(run: TaskRun, snap: TaskSnapshot): void {
    run.status = snap.status;
    run.exitCode = snap.exitCode;
    run.durationMs = snap.durationMs;
    if (snap.command) run.command = snap.command;
    this.commitRunLine(run);
    this.appendEndLine(run, snap);
    run.sink.appendDivider();
    if (this.feedsProblems(run.task)) {
      this.buildProblems.append(this.buildDiagnostics.flush(this.diagnosticsChannel(snap.runId, "")));
    }
    if (run.task === "build") {
      this.buildProgress = null;
      this.renderBuildProgress();
    }
    this.syncPips();
    this.updateActions();
  }

  private appendEndLine(run: TaskRun, snap: TaskSnapshot): void {
    const { text, ok } = endLineFor(snap.status, snap.exitCode, snap.durationMs);
    if (run.sink !== this.buildLog) {
      run.sink.appendEndLine(text, ok);
      return;
    }
    const tone = snap.status === "done" ? "success" : !ok ? "error" : null;
    run.sink.openLine(ok ? "meta" : "stderr").set(`${text}\n`, tone);
  }

  private syncPips(): void {
    this.syncPip(this.terminal.pipEl, "terminal");
    this.syncPip(this.build.pipEl, BUILD_TAB);
  }

  private syncPip(pip: HTMLElement | null, tab: string): void {
    if (!pip) return;
    const runs = [...this.runs.values()].filter(
      (run) => this.surfaceTab(run.task) === tab,
    );
    if (runs.some((run) => run.status === "running")) {
      pip.className = "devmode-panel-pip is-running";
      return;
    }
    const finished = runs
      .filter((run) => run.status !== "idle" && run.status !== "running")
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (!finished) {
      pip.className = "devmode-panel-pip";
      return;
    }
    const failed =
      finished.status === "failed" ||
      finished.status === "timeout" ||
      finished.status === "spawn-error";
    pip.className = `devmode-panel-pip ${failed ? "is-failed" : "is-ok"}`;
  }

  private revealRunningRun(run: TaskRun): void {
    if (run.status !== "running") return;
    const tab = this.surfaceTab(run.task);
    if (this.active === tab && this.open) return;
    if (tab === "terminal" && this.terminalTyping && this.open) return;
    this.show(tab);
  }

  private writeRunText(
    run: TaskRun,
    text: string,
    stream: "stdout" | "stderr",
  ): void {
    if (!text) return;
    const normalized = text.replace(/\r\n/g, "\n");
    for (const token of normalized.split(/(\r|\n)/)) {
      if (!token) continue;
      if (token === "\n") {
        if (run.live) this.commitRunLine(run);
        else run.sink.appendOutput("\n", stream);
        continue;
      }
      if (token === "\r") {
        run.liveText = "";
        run.liveStream = stream;
        if (run.live) this.renderRunLine(run, stream);
        continue;
      }
      if (run.liveStream !== stream) this.commitRunLine(run);
      run.liveStream = stream;
      run.liveText += token;
      this.renderRunLine(run, stream);
    }
  }

  private renderRunLine(run: TaskRun, stream: "stdout" | "stderr"): void {
    if (!run.live) run.live = run.sink.openLine(stream);
    if (run.sink === this.buildLog) {
      const text = stripBuildAnsi(run.liveText);
      run.live.set(text, buildOutputTone(text) ?? null);
    } else {
      run.live.set(run.liveText);
    }
  }

  private commitRunLine(run: TaskRun): void {
    const line = run.live;
    if (!line) return;
    const text = line.text;
    this.resetLive(run);
    line.set(`${text}\n`);
  }

  private resetLive(run: TaskRun): void {
    run.live = null;
    run.liveText = "";
    run.liveStream = "stdout";
  }
}
