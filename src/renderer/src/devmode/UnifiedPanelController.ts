import {
  ChevronDown,
  ChevronUp,
  Bug,
  Rocket,
  Search,
  Square,
  SquareTerminal,
  Terminal,
  Trash2,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { Ellipsis, Hammer } from "lucide";
import type { IconNode } from "../ui/originalIcons.js";
import { TerminalPaneView } from "./TerminalPaneView.js";
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

/** Default / clamp for the editor-column bottom panel (px). */
const PANEL_HEIGHT_KEY = "jellybot.devmode.panelHeight";
export const PANEL_DEFAULT_HEIGHT = 232;
const PANEL_MIN_HEIGHT = 96;
/** Leave this much editor chrome visible while the panel is expanded. */
const PANEL_EDITOR_RESERVE = 80;
const PANEL_MAX_RATIO = 0.75;

/** Task output views; Deploy is visible only when configured. */
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
  pipEl: HTMLElement;
  /** task id for this tab ("build"/"run"), or null for the terminal tab. */
  task: string | null;
  /** Base tab label ("Build"/"Run"/…) for tooltip building. */
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

/** End-of-log footer text for a finished run ("— exit 0 · 4.6s"). */
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
    // quota / private mode
  }
}

/**
 * Unified bottom panel of the Dev Mode editor column (plan:
 * unified-bottom-panel) — one strip, one height:
 *
 *   [ Terminal | Build | Debug | … ]                    Stop ▼
 *   ─ terminal output / task log ─
 *
 * Replaces the two stacked strips (task output panel + terminal drawer).
 * The tab pips carry run status from any tab; task meta (command ·
 * elapsed · exit) lives on the tab tooltip, the exit summary on the
 * log's last line. Sessions and logs live in main — closing the panel
 * keeps them alive.
 */
export class UnifiedPanelController {
  readonly root: HTMLElement;
  private readonly resizeHandle: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly spacerEl: HTMLElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly moreLabel: HTMLElement;
  private readonly morePip: HTMLElement;
  private readonly moreMenu: HTMLElement;
  private readonly overflowTabsEl: HTMLElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly collapseBtn: HTMLButtonElement;
  /** Terminal view host — the run logic controller attaches to this. */
  readonly terminalView: TerminalPaneView;
  private readonly terminal: TaskViewState;
  private readonly tasks = new Map<string, TaskViewState>();

  private active = "terminal" as string;
  private open = false;
  private collapsed = true;
  private workspacePath: string | null = null;
  private subscribed = false;
  private unwatchOutput: (() => void) | null = null;
  private unwatchExit: (() => void) | null = null;
  private unwatchProgress: (() => void) | null = null;
  /** Latest build progress frame for the followed build run. */
  private buildProgress: DevTaskProgressSnapshot | null = null;
  /** Progress strip elements — chip / counts / bar / pct / eta. */
  private readonly progressStrip: HTMLElement;
  private readonly progressChip: HTMLElement;
  private readonly progressCounts: HTMLElement;
  private readonly progressPct: HTMLElement;
  private readonly progressEta: HTMLElement;
  private readonly progressFill: HTMLElement;
  /** True while the user is in the terminal input (blocks auto-switch). */
  private terminalTyping = false;
  /** Panel visibility — drives the outline Terminal button `is-on`. */
  onOpenChange: ((open: boolean) => void) | null = null;
  /**
   * True while the panel content is expanded. The shared toolbar remains
   * visible in both states.
   */
  onPresentedChange: ((presented: boolean) => void) | null = null;
  debugConsoleControllerClear: (() => void) | null = null;
  referencesControllerClear: (() => void) | null = null;
  /** Unreal / Electron / web workspaces — Debug / Debug Console tabs stay hidden otherwise. */
  private deployAvailable = false;
  private debugAvailable = false;
  private debugKind: DebugRecipe | null = null;
  /** A live session (possibly from another workspace) keeps the tabs reachable. */
  private debugSessionLive = false;

  private heightPx = PANEL_DEFAULT_HEIGHT;
  private dragging = false;
  private dragStartY = 0;
  private dragStartHeight = 0;
  private readonly onPointerMove = (event: PointerEvent): void =>
    this.handlePointerMove(event);
  private readonly onPointerUp = (event: PointerEvent): void =>
    this.handlePointerUp(event);
  private readonly onOutsidePointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target && !this.moreMenu.contains(target) && !this.moreBtn.contains(target)) {
      this.closeMore();
    }
  };
  private readonly onMenuKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.closeMore();
    this.moreBtn.focus();
  };

  constructor() {
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

    // ---------------------------------------------------------- tab strip
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

    // Spacer between tabs and actions — tabs left, actions right. Run
    // status lives on the tab pips; no contextual text in the strip.
    this.spacerEl = document.createElement("div");
    this.spacerEl.className = "devmode-panel-tabs-spacer";

    this.moreBtn = document.createElement("button");
    this.moreBtn.type = "button";
    this.moreBtn.className = "devmode-panel-ghost devmode-panel-more";
    this.moreBtn.title = "More tools";
    this.moreBtn.setAttribute("aria-label", "More tools");
    this.moreBtn.setAttribute("aria-expanded", "false");
    this.moreLabel = document.createElement("span");
    this.moreLabel.className = "devmode-panel-more-label";
    this.morePip = document.createElement("span");
    this.morePip.className = "devmode-panel-pip";
    this.moreBtn.append(
      this.moreLabel,
      createLucideIcon(Ellipsis, { size: 12 }),
      this.morePip,
    );
    this.moreBtn.addEventListener("click", () => {
      if (this.moreMenu.hidden) this.openMore();
      else this.closeMore();
    });
    this.moreBtn.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      this.openMore();
      const first = [...this.overflowTabsEl.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => !button.hidden);
      (first ?? this.clearBtn).focus();
    });
    this.moreMenu = document.createElement("div");
    this.moreMenu.className = "devmode-panel-more-menu";
    this.moreMenu.hidden = true;
    this.moreMenu.setAttribute("aria-label", "More panel tools");
    this.overflowTabsEl = document.createElement("div");
    this.overflowTabsEl.className = "devmode-panel-overflow-tabs";
    this.overflowTabsEl.setAttribute("role", "tablist");
    this.overflowTabsEl.setAttribute("aria-label", "More panel tools");
    this.overflowTabsEl.setAttribute("aria-orientation", "vertical");
    this.overflowTabsEl.append(this.tasks.get("deploy")!.tab);

    this.stopBtn = document.createElement("button");
    this.stopBtn.type = "button";
    this.stopBtn.className = "devmode-panel-ghost is-danger";
    this.stopBtn.title = "Terminate the process group";
    this.stopBtn.append(
      createLucideIcon(Square, { size: 10, strokeWidth: 2 }),
      document.createTextNode("Stop"),
    );
    this.stopBtn.addEventListener("click", () => this.stopActive());

    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button";
    this.clearBtn.className = "devmode-panel-ghost devmode-panel-more-clear";
    this.clearBtn.title = "Clear output";
    this.clearBtn.append(
      createLucideIcon(Trash2, { size: 11 }),
      document.createTextNode("Clear output"),
    );
    this.clearBtn.addEventListener("click", () => {
      this.closeMore();
      this.clearActive();
    });
    this.moreMenu.append(this.overflowTabsEl, this.clearBtn);

    this.collapseBtn = document.createElement("button");
    this.collapseBtn.type = "button";
    this.collapseBtn.className = "devmode-panel-ghost is-icon";
    this.collapseBtn.title = "Collapse panel";
    this.collapseBtn.setAttribute("aria-label", "Collapse panel");
    // Chevron direction: expanded = ▼ (click shrinks toward the bottom
    // edge), collapsed = ▲ (click expands upward) — app/VS Code convention.
    this.collapseBtn.append(createLucideIcon(ChevronDown, { size: 12 }));
    this.collapseBtn.addEventListener("click", () => this.setCollapsed(!this.collapsed));

    // One persistent strip; secondary tools and the existing Clear action
    // share the overflow menu. Content views remain direct root children.
    this.tabsEl.append(
      this.terminal.tab,
      this.tasks.get("build")!.tab,
      this.moreBtn,
      this.spacerEl,
      this.stopBtn,
      this.collapseBtn,
    );

    // Build progress strip — between the tab strip and the views; a glance
    // row for the running UBT build (same devtask:progress source as the
    // conversation card). Hidden unless the Build tab shows a live run.
    this.progressStrip = document.createElement("div");
    this.progressStrip.className = "devmode-panel-progress";
    this.progressStrip.hidden = true;
    this.progressChip = document.createElement("span");
    this.progressChip.className = "devmode-panel-progress-chip";
    this.progressCounts = document.createElement("span");
    this.progressCounts.className = "devmode-panel-progress-counts";
    const bar = document.createElement("div");
    bar.className = "devmode-panel-progress-bar";
    this.progressFill = document.createElement("div");
    this.progressFill.className = "devmode-panel-progress-bar-fill";
    bar.append(this.progressFill);
    this.progressPct = document.createElement("span");
    this.progressPct.className = "devmode-panel-progress-pct";
    this.progressEta = document.createElement("span");
    this.progressEta.className = "devmode-panel-progress-eta";
    this.progressStrip.append(
      this.progressChip,
      this.progressCounts,
      bar,
      this.progressPct,
      this.progressEta,
    );

    this.root.append(
      this.resizeHandle,
      this.tabsEl,
      this.moreMenu,
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

  /** Existing file status mounts in the same strip instead of a second row. */
  get statusHost(): HTMLElement {
    return this.spacerEl;
  }

  installDebugView(root: HTMLElement): void {
    if (this.tasks.has("debug")) return;
    const state = this.makeView("debug", "Debug", Bug, null);
    state.view.replaceChildren(root);
    this.tasks.set("debug", state);
    this.tabsEl.insertBefore(state.tab, this.moreBtn);
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
    this.overflowTabsEl.append(state.tab);
    this.root.append(state.view);
    this.applyDebugTitles();
    this.applyDebugVisibility();
  }

  installReferencesView(root: HTMLElement): void {
    if (this.tasks.has("references")) return;
    const state = this.makeView("references", "References", Search, null);
    state.view.replaceChildren(root);
    this.tasks.set("references", state);
    this.overflowTabsEl.append(state.tab);
    this.root.append(state.view);
    this.syncMoreButton();
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

  /**
   * Live-session liveness — Debug tabs stay visible for Stop even when the
   * current workspace has no debug recipe (session running elsewhere).
   */
  setDebugSessionLive(live: boolean): void {
    if (this.debugSessionLive === live) return;
    this.debugSessionLive = live;
    this.applyDebugVisibility();
    this.updateActions();
  }

  private syncDeployVisibility(): void {
    const state = this.tasks.get("deploy")!;
    // Keep an existing run accessible for Stop and log review if config is removed.
    state.tab.hidden = !this.deployAvailable && state.runId === null;
    if (state.tab.hidden && this.active === "deploy") this.activate("terminal");
    this.syncMoreButton();
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
    this.syncMoreButton();
  }

  /** One tab button + view; task tabs get a status pip. */
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

    tab.addEventListener("click", () => this.show(id));
    return {
      tab,
      view,
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
        // Fresh run for this workspace → follow it on its tab.
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
    // Terminal input focus guards the auto-switch (never steal mid-typing).
    const input = this.terminalView.input;
    input.addEventListener("focus", () => {
      this.terminalTyping = true;
    });
    input.addEventListener("blur", () => {
      this.terminalTyping = false;
    });
  }

  destroy(): void {
    this.closeMore();
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
    this.root.remove();
  }

  // -------------------------------------------------------- state lookups

  private stateForTask(task: string): TaskViewState | null {
    if (task === "run" && !this.tasks.has(task)) {
      const state = this.makeView("run", "Run", SquareTerminal, "run");
      this.tasks.set("run", state);
      this.overflowTabsEl.append(state.tab);
      this.root.append(state.view);
      this.syncMoreButton();
    }
    return this.tasks.get(task) ?? null;
  }

  private stateForActive(): TaskViewState | null {
    return this.active === "terminal"
      ? this.terminal
      : this.stateForTask(this.active);
  }

  // ------------------------------------------------------- open/visibility

  /** Panel open state — drives the outline Terminal toolbar button. */
  isOpen(): boolean {
    return this.open;
  }

  /** Open on the Terminal tab (outline button focuses the input). */
  revealTerminal(focusInput = true): void {
    this.show("terminal");
    if (focusInput) this.terminalView.focusInput();
  }

  /**
   * Outline Build/Run clicked (or re-clicked while running) — open on that
   * task's tab. If the run IPC is still in flight (no snapshot yet), the
   * view shows a waiting line until the first chunk lands.
   */
  revealForTask(task: string): void {
    this.stateForTask(task);
    const tab = this.tasks.has(task) ? task : "terminal";
    const state = this.tasks.get(task);
    if (state && state.status === "idle") {
      state.status = "waiting";
      state.command = "";
      state.view.replaceChildren(
        this.lineEl("Waiting for output…", "is-dim"),
      );
      state.pendingLine = null;
    }
    // Escape hatch for a stale panel (e.g. a superseded workspace switch
    // raced the replay): if main still runs this task, adopt it now.
    if (state) void this.adoptActiveRun(state);
    this.show(tab);
  }

  /**
   * Attach-only self-heal: query main for an active run of the tab's task
   * and follow it. Never resets — a genuinely fresh click (no run yet)
   * keeps its "Waiting for output…" line untouched.
   */
  private async adoptActiveRun(state: TaskViewState): Promise<void> {
    const bridge = window.jellybot;
    const ws = this.workspacePath;
    const task = state.task;
    if (!bridge?.getDevTaskState || !ws || !task) return;
    if (state.status === "running" && state.runId) return; // already live
    let active;
    try {
      const snapshot = await bridge.getDevTaskState(ws);
      if (ws !== this.workspacePath) return;
      active = snapshot.active.find((r) => r.task === task);
    } catch {
      return; // cosmetic heal — leave the waiting line
    }
    if (!active || active.runId === state.runId) return;
    this.attachRun(state, active);
  }

  private show(tab: string): void {
    this.closeMore();
    this.open = true;
    this.root.hidden = false;
    this.collapsed = false;
    this.root.classList.remove("is-collapsed");
    this.resizeHandle.hidden = false;
    this.syncCollapseA11y();
    this.applyHeight(this.heightPx, false);
    this.activate(tab);
    this.onOpenChange?.(true);
    // Re-opening always expands — the presented state flips too.
    this.onPresentedChange?.(true);
  }

  hide(): void {
    if (!this.open) return;
    this.closeMore();
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
    this.closeMore();
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
      createLucideIcon(this.collapsed ? ChevronUp : ChevronDown, {
        size: 12,
      }),
    );
  }

  // -------------------------------------------------------------- resize

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
        // linkedom / tests — window listeners still drive the drag
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
    // Dragging the top edge up (smaller Y) grows the panel.
    const next = this.dragStartHeight + (this.dragStartY - event.clientY);
    this.applyHeight(next, false);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    try {
      this.resizeHandle.releasePointerCapture(event.pointerId);
    } catch {
      // already released
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

  /** Tab activation — view swap + action visibility refresh. */
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
    // Stale-panel heal: a task tab that is not following a live run
    // re-queries main — recovers a panel stranded by a superseded
    // workspace switch (log/progress lost while the run kept going).
    const activated = this.tasks.get(tab);
    if (activated?.task && activated.status !== "running") {
      void this.adoptActiveRun(activated);
    }
  }

  /**
   * Paint the progress strip from {@link buildProgress}. Shown only while
   * the Build tab presents a live run with a parsed progress frame — the
   * pips / end-line footer keep carrying terminal state.
   */
  private renderBuildProgress(): void {
    const build = this.tasks.get("build");
    const show =
      this.active === "build" &&
      build?.status === "running" &&
      this.buildProgress != null;
    this.progressStrip.hidden = !show;
    const p = this.buildProgress;
    if (!show || !p) return;
    const meta = BUILD_PHASE_META[p.phase] ?? BUILD_PHASE_META.analyzing!;
    // Loader phases (analyzing) spin their chip icon — see devmode.css.
    this.progressChip.classList.toggle("is-spin", meta.spin === true);
    this.progressChip.replaceChildren(createLucideIcon(meta.icon, { size: 11 }));
    const label = document.createElement("span");
    label.textContent = meta.label;
    this.progressChip.append(label);
    if (p.doneActions != null && p.totalActions != null) {
      this.progressCounts.textContent = `${p.doneActions}/${p.totalActions}`;
      const pct = Math.floor((p.doneActions / p.totalActions) * 100);
      this.progressPct.textContent = `${pct}%`;
      this.progressFill.classList.toggle("indeterminate", !meta.determinate);
      this.progressFill.classList.toggle("linking", p.phase === "linking");
      this.progressFill.style.width = `${(
        (p.doneActions / Math.max(1, p.totalActions)) *
        100
      ).toFixed(1)}%`;
    } else {
      this.progressCounts.textContent =
        p.phase === "generating" ? "UHT" : "targets";
      this.progressPct.textContent = "";
      this.progressFill.classList.add("indeterminate");
      this.progressFill.classList.remove("linking");
      this.progressFill.style.width = "100%";
    }
    this.progressEta.textContent =
      p.etaMs != null && p.phase !== "linking"
        ? `≈${formatBuildDuration(p.etaMs)}`
        : "";
  }

  private *allStates(): Generator<[string, TaskViewState]> {
    yield ["terminal", this.terminal];
    for (const [id, s] of this.tasks) yield [id, s];
  }

  // ------------------------------------------------------------ workspace

  setWorkspace(path: string | null): void {
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

  /**
   * Re-assert the panel's workspace before a task reveal — heals a panel
   * left on the wrong project by an interrupted switch. No-op when already
   * in step: a healthy panel must not re-replay on every button click.
   */
  ensureWorkspace(path: string | null): void {
    if (path === null) {
      if (this.workspacePath !== null) this.setWorkspace(null);
      return;
    }
    if (norm(path) === norm(this.workspacePath ?? "")) return;
    this.setWorkspace(path);
  }

  /** Latest state from main: follow running tasks, restore last logs. */
  private async replay(): Promise<void> {
    const bridge = window.jellybot;
    const ws = this.workspacePath;
    if (!bridge || !ws) return;
    let state;
    try {
      state = await bridge.getDevTaskState(ws);
    } catch {
      return;
    }
    if (ws !== this.workspacePath) return;
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
    // Same rule as the old task panel: a live run surfaces the panel (Dev
    // Mode entry / project switch); finished runs only refresh the pips.
    if (newestRunning && !this.open) this.show(newestRunning.task!);
  }

  // -------------------------------------------------------------- actions

  /** Right-side action visibility — follows the active tab only. */
  private updateActions(): void {
    if (this.active === "terminal") {
      this.stopBtn.hidden = !this.terminalView.busy;
      this.clearBtn.hidden = false;
    } else if (this.active === "debug") {
      // The debug toolbar carries its own Stop — a second one in the strip
      // is redundant.
      this.stopBtn.hidden = true;
      this.clearBtn.hidden = true;
    } else if (this.active === "debug-console" || this.active === "references") {
      this.stopBtn.hidden = true;
      this.clearBtn.hidden = false;
    } else {
      const state = this.stateForActive();
      this.stopBtn.hidden = state?.status !== "running";
      this.clearBtn.hidden = false;
    }
    if (this.collapsed) {
      this.stopBtn.hidden = true;
      this.clearBtn.hidden = true;
    }
    this.syncMoreButton();
  }

  private syncMoreButton(): void {
    const overflow = [...this.tasks.values()].filter(
      (state) => state.tab.parentElement === this.overflowTabsEl && !state.tab.hidden,
    );
    const selected = overflow.find((state) => state.id === this.active);
    this.moreLabel.textContent = selected?.label ?? "";
    this.moreLabel.hidden = !selected;
    this.moreBtn.classList.toggle("is-on", !!selected);
    this.moreBtn.title = selected?.tab.title ?? "More tools";
    this.moreBtn.setAttribute("aria-label", selected ? `${selected.label} — More tools` : "More tools");
    this.moreBtn.hidden = overflow.length === 0 && this.clearBtn.hidden;
    const indicator = overflow.find((state) => state.pipEl.classList.contains("is-running"))
      ?? overflow.find((state) => state.pipEl.classList.contains("is-failed"))
      ?? (selected?.task ? selected : undefined);
    this.morePip.className = indicator?.pipEl.className ?? "devmode-panel-pip";
    if (this.moreBtn.hidden) this.closeMore();
  }

  private openMore(): void {
    this.moreMenu.hidden = false;
    this.moreBtn.setAttribute("aria-expanded", "true");
    const parentTop = this.root.parentElement?.getBoundingClientRect().top ?? 0;
    this.moreMenu.classList.toggle(
      "opens-down",
      this.moreMenu.getBoundingClientRect().top < parentTop,
    );
    document.addEventListener("pointerdown", this.onOutsidePointerDown);
    document.addEventListener("keydown", this.onMenuKeyDown, true);
  }

  private closeMore(): void {
    this.moreMenu.hidden = true;
    this.moreMenu.classList.remove("opens-down");
    this.moreBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.onOutsidePointerDown);
    document.removeEventListener("keydown", this.onMenuKeyDown, true);
  }

  /**
   * Task meta lives on the tab tooltip now — the strip stays clean and
   * the pip carries the at-a-glance signal (spin / green / red).
   */
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
    else this.syncMoreButton();
  }

  /** Debug tab tooltips follow the workspace recipe. */
  private applyDebugTitles(): void {
    const dbg = this.tasks.get("debug");
    if (dbg) dbg.tab.title = debugPanelContextTitle(this.debugKind);
    const con = this.tasks.get("debug-console");
    if (con) con.tab.title = debugConsoleContextTitle(this.debugKind);
    this.syncMoreButton();
  }

  /** `— exit N · Xs` footer inside the task log (status lives in-tab). */
  private appendEndLine(
    state: TaskViewState,
    text: string,
    ok: boolean,
  ): void {
    const el = this.lineEl(text);
    el.classList.add(ok ? "is-end-ok" : "is-end-bad");
    state.view.append(el);
    state.pendingLine = null;
  }

  // --------------------------------------------------------------- actions

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

  /** Terminal stop hook — DevModeController binds the run controller. */
  terminalControllerStop: (() => void) | null = null;

  private clearActive(): void {
    if (this.active === "debug") return;
    if (this.active === "debug-console") {
      this.debugConsoleControllerClear?.();
      return;
    }
    if (this.active === "references") {
      this.referencesControllerClear?.();
      return;
    }
    if (this.active === "terminal") {
      this.terminalView.clearOutput();
      return;
    }
    const state = this.stateForActive();
    if (!state) return;
    state.view.replaceChildren();
    state.pendingLine = null;
  }

  // ---------------------------------------------------------------- stream

  /** Fresh run seen from the stream — reset the view, spin the pip. */
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
    state.view.replaceChildren();
    this.setPip(state, "running");
    this.startTicker(state);
    this.setTabTitle(state);
    this.updateActions();
    if (state.task === "build") {
      this.buildProgress = null;
      this.renderBuildProgress();
    }
  }

  /** Adopt a run snapshot (replay on workspace switch / Dev Mode entry). */
  private attachRun(state: TaskViewState, run: TaskSnapshot): void {
    this.stopTicker(state);
    state.runId = run.runId;
    state.command = run.command;
    state.status = run.status;
    state.exitCode = run.exitCode;
    state.startedAt = run.startedAt;
    state.durationMs = run.durationMs;
    state.pendingLine = null;
    state.view.replaceChildren();
    for (const line of run.buffer.split("\n")) {
      if (line || run.buffer.endsWith("\n")) {
        state.view.append(this.lineEl(line === "" ? " " : line));
      }
    }
    if (run.buffer && !run.buffer.endsWith("\n")) {
      // Last line is partial — keep appending into it.
      const lines = state.view.children;
      const last = lines[lines.length - 1];
      if (last instanceof HTMLDivElement) state.pendingLine = last;
    }
    this.trimLines(state);
    if (run.status !== "running") {
      // Finished run — restore the same end-of-log footer live exits get.
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
    state.view.replaceChildren();
    if (state.task === "build") {
      this.buildProgress = null;
      this.renderBuildProgress();
    }
    this.setPip(state, "none");
    this.setTabTitle(state);
    this.updateActions();
  }

  private setPip(state: TaskViewState, kind: string): void {
    state.pipEl.className = `devmode-panel-pip is-${kind}`;
    this.syncMoreButton();
  }

  /**
   * A running task's first live chunk switches the panel to its tab —
   * unless the user is typing in the terminal input (pip updates only).
   * A closed panel opens for the fresh run (agent-triggered /build /run).
   */
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
    // UBT/UBA progress often uses `\r` to rewrite the current `[n/N] Compile`
    // line. Treat CR as "replace pending line"; LF still closes it.
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
      state.view.append(state.pendingLine);
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
    const count = state.view.childElementCount;
    if (count <= MAX_LINES) return;
    for (let i = 0; i < TRIM_BATCH && state.view.firstElementChild; i++) {
      if (state.view.firstElementChild === state.pendingLine) break;
      state.view.firstElementChild.remove();
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
    state.view.scrollTop = state.view.scrollHeight;
  }
}
