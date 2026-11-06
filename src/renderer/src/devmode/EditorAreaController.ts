/**
 * Dev Mode editor area — tabs + Monaco + save/merge engine (plan: dev-mode-v1).
 *
 * Save model: Cmd+S manual save, dirty dot, close-tab intercept (§decisions).
 * fs.watch engine per tab:
 *   - clean buffer → silent reload (single undoable edit);
 *   - dirty buffer → merge3(base=last load/save, ours=buffer, theirs=disk):
 *     non-colliding agent hunks auto-merge in, collisions resolve agent-wins,
 *     the whole merge applies as ONE undoable edit (Cmd+Z reverts it whole).
 *   - unlink → tab marked "Deleted on disk"; saving recreates the file.
 * Monaco loads lazily (first tab open) via monacoSetup (inline blob workers).
 *
 * Tab context menu: Close / Close Others / Close All / Annotate (blame).
 * Annotate paints `n <rev> <author> [age]` in the line-numbers column and
 * refreshes after saves / agent writes. Floating toggles (minimap, default
 * off; annotate) hover at the editor's top-right corner.
 */
import type * as MonacoTypes from "monaco-editor";
import type { BreakpointValue } from "./breakpointStore.js";
import {
  blameBandSlots,
  blameGutterLabel,
  blameHoverText,
  blameLabelColumns,
  type BlameEntry,
  type BlameKind,
} from "./blameFormat.js";
import { BlameHoverController } from "./BlameHoverController.js";
import { showDevMenu } from "./ctxMenu.js";
import {
  EditorDiffController,
  type EditorDiffDocument,
} from "./EditorDiffController.js";
import { DebugHoverController } from "./DebugHoverController.js";
import { DebugHoverView } from "./DebugHoverView.js";
import type { DebugHoverValue } from "./DebugController.js";
import { AGENT_OPEN_MAX_TABS, pickAgentEvictionVictim } from "./editorTabs.js";
import {
  normalizeFlashRanges,
  type AgentFlashRange,
} from "./agentFlash.js";

/** Decorations outlive the 1.5s animation slightly, then get reclaimed. */
const FLASH_CLEAR_MS = 1800;
import { registerCppLanguageFeatures } from "./cppLanguageFeatures.js";
import type { CppGotoTarget } from "./cppLanguageFeatures.js";
import {
  clangdGotoDefinition,
  clangdWorkspaceSymbols,
  registerClangdProviders,
  type ClangdMonacoLike,
} from "./clangdFeatures.js";
import { modelUriToPath, qualifiedContainerBefore } from "./cppLanguageFeatures.js";
import {
  resolveCppCounterpart,
} from "./cppCounterpart.js";
import type { CppUsageTarget } from "./cppFindUsages.js";
import { formatCppSymbolIndexProgress } from "./cppSymbolProgress.js";
import {
  applyClangdProgress,
  clangdProgressNeedsTick,
  createClangdProgressState,
  formatClangdProgress,
} from "./clangdProgress.js";
import { languageForPath } from "./languages.js";
import { createLanguageIcon } from "../ui/languageIcons.js";
import {
  definitionTargetFromOpener,
  isUhtGeneratedPath,
  DEFINITION_TEXT_GRACE_MS,
  pickJumpTarget,
  pickUhtHandwrittenTarget,
  raceWithGrace,
  uhtRedirectQuery,
  type UhtJumpCandidate,
} from "./goToDefinition.js";
import { merge3 } from "./merge3.js";
import { isDevModalOpen } from "./modalLayer.js";
import {
  DEV_MODE_EDITOR_BG,
  loadMonaco,
  resolveDevModeTheme,
  type MonacoApi,
} from "./monacoSetup.js";
import { baseNameOf } from "./slnPaths.js";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  createLucideIcon,
  X,
} from "../ui/originalIcons.js";
import { createDevModeIcon, type DevModeIconName } from "./launchIcon.js";
import { debugButtonTitle, type DebugRecipe } from "../../../debug/debugCopy.js";

type EditorTab = {
  path: string;
  label: string;
  languageId: string;
  model: MonacoTypes.editor.ITextModel | null;
  /** Held while Monaco is still loading (tab opened pre-editor). */
  pendingContent: string | null;
  /** Content at last load/save — the diff3 "ancestor". */
  baseContent: string;
  /** Content last written to / read from disk (drives the dirty dot). */
  savedContent: string;
  dirty: boolean;
  readOnly: boolean;
  hadBom: boolean;
  status: "ok" | "deleted";
  viewState: MonacoTypes.editor.ICodeEditorViewState | null;
  /** Gutter marks (vcs diff vs HEAD/BASE); null = not fetched yet. */
  vcsDiff: VcsFileDiff | null;
  /** Annotate (blame) — gutter labels to the left of the line numbers. */
  annotated: boolean;
  blame: BlameEntry[] | null;
  blameKind: "git" | "svn" | null;
};

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

const RELOAD_COALESCE_MS = 120;

/** Global minimap preference (default OFF — toggle floats top-right). */
const MINIMAP_KEY = "jellybot.devModeMinimap";
/** Per-line blame hover tooltips stop paying off past this many lines. */
const BLAME_HOVER_MAX_LINES = 5000;
const PLAIN_LINE_NUMBER_MIN_CHARS = 3;
/** Lines-decorations lane: narrow normally, wider to seat the blame band. */
const PLAIN_LINE_DECORATIONS_WIDTH = 5;
const BLAME_LINE_DECORATIONS_WIDTH = 9;

/**
 * Per-project open-tab memory, keyed by workspace path (localStorage).
 * Saved set = { files: [...paths in tab order], active }.
 */
const TABS_KEY_PREFIX = "jellybot.devmode.tabs.";
const TAB_SAVE_DEBOUNCE_MS = 500;
/** Restore cap — a pathological saved state must not brick the editor. */
const RESTORE_MAX_TABS = 12;

function readMinimapEnabled(): boolean {
  try {
    return localStorage.getItem(MINIMAP_KEY) === "1";
  } catch {
    return false; // quota / private mode
  }
}

type SavedTabState = { files: string[]; active: string | null };

function tabsKeyFor(workspaceRoot: string): string {
  return `${TABS_KEY_PREFIX}${workspaceRoot}`;
}

function readSavedTabs(workspaceRoot: string): SavedTabState | null {
  try {
    const raw = localStorage.getItem(tabsKeyFor(workspaceRoot));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as SavedTabState).files)
    ) {
      return null;
    }
    const files = (parsed as SavedTabState).files.filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    );
    const active = (parsed as SavedTabState).active;
    return {
      files: files.slice(0, RESTORE_MAX_TABS),
      active: typeof active === "string" ? active : null,
    };
  } catch {
    return null; // corrupted entry — treat as absent
  }
}

function writeSavedTabs(
  workspaceRoot: string,
  state: SavedTabState | null,
): void {
  try {
    if (state && state.files.length > 0) {
      localStorage.setItem(tabsKeyFor(workspaceRoot), JSON.stringify(state));
    } else {
      localStorage.removeItem(tabsKeyFor(workspaceRoot));
    }
  } catch {
    // quota / private mode — session restore is best-effort
  }
}

/**
 * How the active tab came to change. "tab" = the user targeted a tab in the
 * strip (click / right-click) — the outline fully reveals the file (expand →
 * select → center). "close" = the tab went away and its successor took the
 * active slot — same full reveal so the tree lands on the file now shown.
 * "open" covers every other activation path (tree click, Quick Open, search,
 * restore) — the outline syncs its selection in place without scrolling.
 */
export type TabActivationSource = "tab" | "open" | "close";

export type EditorAreaOptions = {
  /** Active tab changed (click / open / close cascade) — outline follows it. */
  onActiveTabChanged?: (path: string, source: TabActivationSource) => void;
  /** Tab menu "Reveal in File Tree" — Dev Mode expands + centers the row. */
  onRevealInTree?: (path: string) => void;
  /** Workspace root for VCS gutter marks (null → marks disabled). */
  getWorkspaceRoot?: () => string | null;
  /** Diff mode changed; Dev Mode uses enable to collapse the chat pane. */
  onDiffModeChanged?: (enabled: boolean) => void;
  /** User clicked a gutter line (glyph lane or line number). */
  onBreakpointToggle?: (path: string, line: number) => void;
  /** Right-click / Alt-click a gutter line — edit the breakpoint condition. */
  onBreakpointCondition?: (path: string, line: number) => void;
  /** Resolve an expression while the debug target is paused. */
  onDebugHover?: (expression: string) => Promise<DebugHoverValue | null>;
  /** Lazily resolve one expandable DAP variable node. */
  onDebugVariables?: (
    variablesReference: number,
  ) => Promise<DebugVariable[]>;
  /** Active buffer changed (tab switch, close, or edits). */
  onDocumentChanged?: () => void;
  /** Caret line in the active editor (1-based). */
  onCursorLineChanged?: (line: number) => void;
  /**
   * F12 found no definition — hand the identifier to Quick Open
   * (Ctrl+T symbol search) instead of Monaco's native "no definition" widget.
   */
  onOpenSymbolSearch?: (query: string) => void;
  /** Shift+F12 / editor context menu requested a usage search. */
  onFindUsages?: () => void;
  /**
   * Exact-basename lookup over the loaded Quick Open file index
   * (project + engine tiers). Counterpart resolution uses it between the
   * exact-sibling stats and the scoped filesystem walk — the index is the
   * tier that reliably lists engine sources. Returns null/[] when cold.
   */
  queryFileIndex?: (base: string) =>
    | readonly { path: string; rel: string }[]
    | null;
};

export class EditorAreaController {
  private readonly root: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly tabScroller: HTMLElement;
  private readonly tabPrev: HTMLButtonElement;
  private readonly tabNext: HTMLButtonElement;
  private tabResizeObserver: ResizeObserver | null = null;
  private readonly editorHost: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly emptyTitle: HTMLElement;
  private readonly emptyHint: HTMLElement;
  private readonly statusBar: HTMLElement;
  private readonly statusPath: HTMLElement;
  private readonly statusState: HTMLElement;
  private readonly statusIndex: HTMLElement;
  /** Status-bar right edge — expands the unified bottom panel. */
  readonly statusPanelButton: HTMLButtonElement;

  private tabs: EditorTab[] = [];
  private activePath: string | null = null;
  /** Tab whose model is currently attached to the editor. */
  private attachedPath: string | null = null;
  private monaco: MonacoApi | null = null;
  private monacoPromise: Promise<void> | null = null;
  private cppFeatures: ReturnType<typeof registerCppLanguageFeatures> | null =
    null;
  /** clangd semantic providers (completion/hover/signature help) — null
   *  outside clangd-capable workspaces. */
  private clangdProviders: { dispose(): void } | null = null;
  private editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null;
  private editorOpener: { dispose(): void } | null = null;
  private unsubGoToDefinition: (() => void) | null = null;
  private unsubFindUsages: (() => void) | null = null;
  private unsubSymbolProgress: (() => void) | null = null;
  /** Non-empty while the background C++ symbol scan is running. */
  private symbolProgressText = "";
  /** clangd start / preamble / index progress (status-bar line). */
  private readonly clangdProgress = createClangdProgressState();
  /** 1s ticker keeping elapsed times live while clangd warms up. */
  private clangdProgressTimer: number | null = null;
  /** Workspace the progress state belongs to (hidden after a switch). */
  private clangdProgressRoot: string | null = null;
  /** F12 semantic search hint, also mirrored in the status bar. */
  private gotoWaitText = "";
  /** Tip widget anchored above the word while an F12 clangd query runs. */
  private clangdTipRemover: (() => void) | null = null;
  private unsubClangdProgress: (() => void) | null = null;
  private notice: string | null = null;
  private noticeTimer: number | null = null;
  private readonly reloadTimers = new Map<string, number>();
  private readonly vcsDiffTimers = new Map<string, number>();
  private vcsCollection: MonacoTypes.editor.IEditorDecorationsCollection | null = null;
  private blameCollection: MonacoTypes.editor.IEditorDecorationsCollection | null = null;
  private debugCollection: MonacoTypes.editor.IEditorDecorationsCollection | null = null;
  private debugExecutionCollection: MonacoTypes.editor.IEditorDecorationsCollection | null =
    null;
  private debugFrameCollection: MonacoTypes.editor.IEditorDecorationsCollection | null =
    null;
  /** Agent read/patch line flash — one live collection at a time. */
  private flashCollection: MonacoTypes.editor.IEditorDecorationsCollection | null =
    null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private debugHoverView: DebugHoverView | null = null;
  /** path → line → condition and enabled state. */
  private debugBreakpoints = new Map<
    string,
    Map<number, BreakpointValue>
  >();
  /** Current suspended source location; retained across tab switches. */
  private debugExecutionLocation: { path: string; line: number } | null = null;
  /** Selected (non-top) call-stack frame location; retained across tabs. */
  private debugFrameLocation: { path: string; line: number } | null = null;
  /** Glyph-margin breakpoints exist on Unreal and Electron workspaces. */
  private debugEnabled = false;
  private readonly blameHover = new BlameHoverController();
  private readonly launchPill: HTMLElement;
  private readonly minimapButton: HTMLButtonElement;
  private readonly diffButton: HTMLButtonElement;
  private readonly annotateButton: HTMLButtonElement;
  /** Launch cluster riding the tab bar right edge: [Build][Debug] │ [gear]. */
  private readonly launchRow: HTMLElement;
  private readonly buildButton: HTMLButtonElement;
  private readonly deployButton: HTMLButtonElement;
  private readonly debugLaunchButton: HTMLButtonElement;
  private readonly configButton: HTMLButtonElement;

  /** Workspace launch actions — wired by DevModeController. */
  onBuildClick: (() => void) | null = null;
  onDeployClick: (() => void) | null = null;
  onDebugClick: (() => void) | null = null;
  onConfigClick: (() => void) | null = null;
  private readonly diffController: EditorDiffController;
  private minimapEnabled = readMinimapEnabled();
  /** In-flight minimap hide fade (superseded by rapid re-toggles). */
  private minimapAnim: Animation | null = null;
  /** Path of the tab whose close motion is playing (one at a time). */
  private closingPath: string | null = null;
  /** Close requests parked until the in-flight close motion lands. */
  private readonly pendingCloses: string[] = [];
  /** Workspace root whose tab set is currently persisted (null = none). */
  private savedTabsRoot: string | null = null;
  /** Debounced tab-state write (open/close/activate storms). */
  private saveTabsTimer: number | null = null;
  /** Restore currently in flight — suppresses intermediate saves. */
  private restoringTabs = false;
  /** Bumped on every switch — an in-flight restore aborts on mismatch. */
  private restoreGeneration = 0;
  /**
   * Agent-driven opens (openAgentFile) suppress attachActive()'s editor
   * focus for their duration — a landing write must not steal the caret
   * from the chat composer mid-turn. Cleared in openAgentFile's finally.
   */
  private suppressEditorFocus = false;
  private readonly keydown = (event: KeyboardEvent): void => {
    // A modal covers the workbench — ⌘S belongs to the dialog, not the editor.
    if (isDevModalOpen()) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      void this.saveActive();
    }
  };
  /** Last-chance flush — window closing must not lose the tab memory. */
  private readonly flushTabsOnUnload = (): void => this.flushTabMemory();

  constructor(private readonly options?: EditorAreaOptions) {
    this.root = document.createElement("div");
    this.root.className = "devmode-editor-root";

    this.tabBar = document.createElement("div");
    this.tabBar.className = "devmode-tabs";
    this.tabScroller = document.createElement("div");
    this.tabScroller.className = "devmode-tabs-scroll";

    // Overflow paging (never a scrollbar): < > step through crowded tabs —
    // a compact segmented pill (24px segments, W-B) between the scroller
    // and the launch row (demo: devmode-pager-pill-demo.html).
    const mkNav = (label: string, icon: () => SVGElement): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "devmode-tabs-nav";
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.append(icon());
      return btn;
    };
    this.tabPrev = mkNav("Scroll tabs left", () =>
      createLucideIcon(ChevronLeft, { size: 14, strokeWidth: 2 }),
    );
    this.tabNext = mkNav("Scroll tabs right", () =>
      createLucideIcon(ChevronRight, { size: 14, strokeWidth: 2 }),
    );
    const pagerPill = document.createElement("div");
    pagerPill.className = "devmode-pager-pill";
    pagerPill.setAttribute("role", "group");
    pagerPill.setAttribute("aria-label", "Scroll tabs");
    pagerPill.append(this.tabPrev, this.tabNext);
    this.tabBar.append(this.tabScroller, pagerPill);

    this.editorHost = document.createElement("div");
    this.editorHost.className = "devmode-editor-host";
    const executionArrow = createLucideIcon(ArrowRight, {
      size: 15,
      strokeWidth: 2.5,
    });
    executionArrow.setAttribute("stroke", "#d6a94a");
    this.editorHost.style.setProperty(
      "--devmode-debug-arrow",
      `url("data:image/svg+xml,${encodeURIComponent(executionArrow.outerHTML)}")`,
    );
    // Non-top stack frames get the VS Code convention: a green arrow marks
    // the frame the user picked, distinct from the gold execution arrow.
    const frameArrow = createLucideIcon(ArrowRight, {
      size: 15,
      strokeWidth: 2.5,
    });
    frameArrow.setAttribute("stroke", "#57ab5a");
    this.editorHost.style.setProperty(
      "--devmode-debug-frame-arrow",
      `url("data:image/svg+xml,${encodeURIComponent(frameArrow.outerHTML)}")`,
    );
    this.diffController = new EditorDiffController({
      getWorkspaceRoot: () => this.options?.getWorkspaceRoot?.() ?? null,
      getMinimapEnabled: () => this.minimapEnabled,
      onModeChanged: (enabled) => {
        this.editorHost.classList.toggle("is-diff-hidden", enabled);
        if (enabled) this.blameHover.hide();
        this.options?.onDiffModeChanged?.(enabled);
        if (!enabled) {
          this.editor?.layout();
          this.editor?.focus();
        }
        this.updateEditorToggles();
      },
    });

    this.emptyState = document.createElement("div");
    this.emptyState.className = "devmode-editor-empty";
    this.emptyTitle = document.createElement("div");
    this.emptyTitle.className = "devmode-empty-title";
    this.emptyTitle.textContent = "No file open";
    this.emptyHint = document.createElement("div");
    this.emptyHint.className = "devmode-empty-hint";
    this.emptyHint.textContent =
      "Pick a file from the Solution Outline to view and edit it here.";
    this.emptyState.append(this.emptyTitle, this.emptyHint);

    this.statusBar = document.createElement("div");
    this.statusBar.className = "devmode-editor-status";
    // File info group (path + save state) — pure status bar again; the
    // task head moved into the unified panel's tab strip.
    const statusFileInfo = document.createElement("div");
    statusFileInfo.className = "devmode-status-file";
    this.statusPath = document.createElement("span");
    this.statusPath.className = "devmode-status-path";
    this.statusState = document.createElement("span");
    this.statusState.className = "devmode-status-state";
    statusFileInfo.append(this.statusPath, this.statusState);
    this.statusIndex = document.createElement("span");
    this.statusIndex.className = "devmode-status-index";
    this.statusIndex.hidden = true;
    // Right-edge toggle: expands the unified bottom panel (Build/Run/
    // Terminal) when it is closed — the inverse of the panel's ✕.
    this.statusPanelButton = document.createElement("button");
    this.statusPanelButton.type = "button";
    this.statusPanelButton.className = "devmode-status-panel-btn";
    this.statusPanelButton.title = "Show output panel";
    this.statusPanelButton.setAttribute("aria-label", "Show output panel");
    this.statusPanelButton.append(
      createLucideIcon(ChevronUp, { size: 13 }),
    );
    this.statusBar.append(statusFileInfo, this.statusIndex, this.statusPanelButton);

    // Floating toggles (top-right): minimap (default off) + annotate.
    // Editor-view toggles ride the same pill as the launch actions (V1
    // uniform segments — devmode-merged-pill-demo.html): one control, one
    // set of internal 1px rules, no separate fab row.
    const mkFab = (label: string, icon: DevModeIconName): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "devmode-launch-btn";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.append(createDevModeIcon(icon));
      return btn;
    };
    this.minimapButton = mkFab(
      this.minimapEnabled ? "Hide minimap" : "Show minimap",
      "minimap",
    );
    this.minimapButton.setAttribute(
      "aria-pressed",
      String(this.minimapEnabled),
    );
    this.minimapButton.classList.toggle("is-on", this.minimapEnabled);
    this.minimapButton.addEventListener("click", () =>
      this.setMinimap(!this.minimapEnabled),
    );
    this.diffButton = mkFab("Show side-by-side diff", "diff");
    this.diffButton.disabled = true;
    this.diffButton.addEventListener("click", () => void this.toggleDiff());
    // Annotate (blame): who last touched these lines.
    this.annotateButton = mkFab("Annotate (blame)", "blame");
    this.annotateButton.disabled = true;
    this.annotateButton.addEventListener("click", () => {
      const tab = this.activeTab();
      if (tab) void this.toggleAnnotate(tab.path);
    });
    // Workspace launch cluster — one segmented pill
    // [Build][Debug][gear | minimap][diff][annotate][chat-when-collapsed],
    // Uniform 27px segments with internal 1px rules.
    const mkLaunch = (label: string, icon: DevModeIconName): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "devmode-launch-btn";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.append(createDevModeIcon(icon));
      const pip = document.createElement("span");
      pip.className = "devmode-launch-pip";
      btn.append(pip);
      return btn;
    };
    // Build publishes the workspace artifacts.
    this.buildButton = mkLaunch("Build", "build");
    this.buildButton.addEventListener("click", () => this.onBuildClick?.());
    // Debug launches with the Play glyph — it is the "run the app" action.
    this.debugLaunchButton = mkLaunch(debugButtonTitle(null), "run");
    this.debugLaunchButton.disabled = true;
    this.debugLaunchButton.addEventListener("click", () =>
      this.onDebugClick?.(),
    );
    this.deployButton = mkLaunch("Deploy", "deploy");
    this.deployButton.hidden = true;
    this.deployButton.disabled = true;
    this.deployButton.addEventListener("click", () => this.onDeployClick?.());
    this.configButton = mkLaunch("Configure tasks — .larry/tasks.json", "configure");
    this.configButton.classList.add("devmode-launch-config");
    this.configButton.addEventListener("click", () => this.onConfigClick?.());
    this.launchPill = document.createElement("div");
    this.launchPill.className = "devmode-launch-pill";
    this.launchPill.setAttribute("role", "group");
    this.launchPill.setAttribute("aria-label", "Workspace tasks and views");
    this.launchPill.append(
      this.buildButton,
      this.debugLaunchButton,
      this.deployButton,
      this.configButton,
      this.minimapButton,
      this.diffButton,
      this.annotateButton,
    );
    this.launchRow = document.createElement("div");
    this.launchRow.className = "devmode-editor-launch";
    this.launchRow.append(this.launchPill);

    // The pill rides the tab bar row's right edge — always reachable, even
    // with zero tabs open.
    this.tabBar.append(this.launchRow);

    this.root.append(
      this.tabBar,
      this.editorHost,
      this.diffController.view.root,
      this.emptyState,
      this.statusBar,
    );
    this.unsubSymbolProgress =
      window.jellybot?.onCppSymbolProgress?.((payload) => {
        const root = this.options?.getWorkspaceRoot?.();
        const sameRoot = (left: string, right: string) =>
          left.replace(/\\/g, "/").replace(/\/+$/, "") ===
          right.replace(/\\/g, "/").replace(/\/+$/, "");
        if (!root || !sameRoot(root, payload.rootPath)) return;
        this.symbolProgressText =
          payload.phase === "scanning"
            ? formatCppSymbolIndexProgress(payload.filesDone, payload.filesTotal)
            : "";
        this.renderStatus();
      }) ?? null;
    this.unsubClangdProgress =
      window.jellybot?.onClangdProgress?.((payload) => {
        const root = this.options?.getWorkspaceRoot?.();
        const sameRoot = (left: string, right: string) =>
          left.replace(/\\/g, "/").replace(/\/+$/, "") ===
          right.replace(/\\/g, "/").replace(/\/+$/, "");
        if (!root || !sameRoot(root, payload.rootPath)) return;
        if (this.clangdProgressRoot === null || !sameRoot(this.clangdProgressRoot, root)) {
          Object.assign(this.clangdProgress, createClangdProgressState());
          this.clangdProgressRoot = root;
        }
        applyClangdProgress(this.clangdProgress, payload, Date.now());
        this.syncClangdProgressTimer();
        this.renderStatus();
      }) ?? null;
  }

  mount(host: HTMLElement): void {
    host.replaceChildren(this.root);
    this.renderTabs();
    this.renderStatus();
    this.tabPrev.addEventListener("click", () => this.scrollTabs(-1));
    this.tabNext.addEventListener("click", () => this.scrollTabs(1));
    this.tabScroller.addEventListener("scroll", () => this.updateTabNav());
    this.tabResizeObserver = new ResizeObserver(() => this.updateTabNav());
    this.tabResizeObserver.observe(this.tabScroller);
    window.addEventListener("keydown", this.keydown, true);
    window.addEventListener("beforeunload", this.flushTabsOnUnload);
    this.unsubGoToDefinition?.();
    this.unsubGoToDefinition =
      window.jellybot?.onEditorGoToDefinition?.(() => {
        this.goToDefinition();
      }) ?? null;
    this.unsubFindUsages?.();
    this.unsubFindUsages =
      window.jellybot?.onEditorFindUsages?.(() => {
        this.options?.onFindUsages?.();
      }) ?? null;
  }

  /** Append an extra segment to the merged pill's right end (chat expand). */
  appendFab(btn: HTMLButtonElement): void {
    this.launchPill.append(btn);
  }

  destroy(): void {
    this.flushTabMemory();
    window.removeEventListener("beforeunload", this.flushTabsOnUnload);
    if (this.saveTabsTimer !== null) {
      window.clearTimeout(this.saveTabsTimer);
      this.saveTabsTimer = null;
    }
    window.removeEventListener("keydown", this.keydown, true);
    this.unsubGoToDefinition?.();
    this.unsubGoToDefinition = null;
    this.unsubFindUsages?.();
    this.unsubFindUsages = null;
    this.unsubSymbolProgress?.();
    this.unsubSymbolProgress = null;
    this.unsubClangdProgress?.();
    this.unsubClangdProgress = null;
    if (this.clangdProgressTimer !== null) {
      window.clearInterval(this.clangdProgressTimer);
      this.clangdProgressTimer = null;
    }
    this.cppFeatures?.dispose();
    this.cppFeatures = null;
    this.editorOpener?.dispose();
    this.editorOpener = null;
    this.tabResizeObserver?.disconnect();
    this.tabResizeObserver = null;
    for (const timer of this.reloadTimers.values()) {
      window.clearTimeout(timer);
    }
    this.reloadTimers.clear();
    for (const timer of this.vcsDiffTimers.values()) {
      window.clearTimeout(timer);
    }
    this.vcsDiffTimers.clear();
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.flashCollection?.clear();
    this.flashCollection = null;
    this.vcsCollection?.clear();
    this.vcsCollection = null;
    this.blameCollection?.clear();
    this.blameCollection = null;
    this.debugCollection?.clear();
    this.debugCollection = null;
    this.debugExecutionCollection?.clear();
    this.debugExecutionCollection = null;
    this.debugFrameCollection?.clear();
    this.debugFrameCollection = null;
    this.debugHoverView?.destroy();
    this.debugHoverView = null;
    this.blameHover.destroy();
    this.diffController.destroy();
    for (const tab of this.tabs) {
      tab.model?.dispose();
    }
    this.tabs = [];
    this.pendingCloses.length = 0;
    this.minimapAnim?.cancel();
    this.minimapAnim = null;
    this.editor?.dispose();
    this.editor = null;
    this.root.remove();
  }

  // --------------------------------------------------------- tab memory

  /**
   * Workspace switch (project picked / session changed project):
   * persist the outgoing project's tab set, close current tabs, reopen the
   * new project's remembered tabs. Dirty tabs follow the normal one-shot
   * confirm (discard stays discarded — they are not restored).
   */
  async switchWorkspaceTabs(nextRoot: string | null): Promise<void> {
    // Invalidate any in-flight restore for the previous root.
    this.restoreGeneration++;
    if (this.saveTabsTimer !== null) {
      window.clearTimeout(this.saveTabsTimer);
      this.saveTabsTimer = null;
    }
    this.flushTabMemory();
    const prevRoot = this.savedTabsRoot;
    if (prevRoot === nextRoot) {
      this.savedTabsRoot = nextRoot;
      return;
    }
    this.savedTabsRoot = nextRoot;
    const cleared = await this.closeAllTabsOnSwitch();
    if (!cleared) {
      // User kept the dirty tabs — freeze this root's memory as-is so the
      // old tabs never leak into the new project's remembered set.
      this.savedTabsRoot = prevRoot;
      return;
    }
    if (!nextRoot) return;
    const saved = readSavedTabs(nextRoot);
    if (!saved || saved.files.length === 0) return;
    await this.restoreTabs(saved);
  }

  /** Open saved paths in order; each failure is silent and skipped. */
  private async restoreTabs(saved: SavedTabState): Promise<void> {
    this.restoringTabs = true;
    const generation = this.restoreGeneration;
    try {
      for (const path of saved.files) {
        if (generation !== this.restoreGeneration) return; // switched away
        // Restored in tab order; the saved active file lands last so it
        // ends up focused (openFile activates what it opens).
        if (path === saved.active) continue;
        await this.openFile(path).catch(() => undefined);
      }
      if (generation !== this.restoreGeneration) return;
      const active =
        saved.active && saved.files.includes(saved.active)
          ? saved.active
          : (saved.files[saved.files.length - 1] ?? null);
      if (active) await this.openFile(active).catch(() => undefined);
    } finally {
      if (generation === this.restoreGeneration) {
        this.restoringTabs = false;
        this.scheduleTabSave();
      }
    }
  }

  /**
   * Close every tab for the switch; ONE confirmation covers all dirty
   * tabs. False = user cancelled — tabs stay, memory root rolls back.
   */
  private async closeAllTabsOnSwitch(): Promise<boolean> {
    if (this.tabs.length === 0) return true;
    const dirty = this.tabs.filter((tab) => tab.dirty).length;
    if (dirty > 0) {
      const what =
        dirty === 1
          ? "1 tab has unsaved changes"
          : `${dirty} tabs have unsaved changes`;
      if (
        !window.confirm(
          `${what}. Switch project and discard? (Unsaved tabs won't be restored.)`,
        )
      ) {
        return false;
      }
    }
    for (const tab of [...this.tabs]) this.disposeTab(tab.path);
    return true;
  }

  /** Debounced persist of the current tab set for the tracked root. */
  private scheduleTabSave(): void {
    if (!this.savedTabsRoot || this.restoringTabs) return;
    if (this.saveTabsTimer !== null) window.clearTimeout(this.saveTabsTimer);
    this.saveTabsTimer = window.setTimeout(() => {
      this.saveTabsTimer = null;
      this.flushTabMemory();
    }, TAB_SAVE_DEBOUNCE_MS);
  }

  /** Write the current tab set (or clear) for the tracked root, now. */
  private flushTabMemory(): void {
    const root = this.savedTabsRoot;
    if (!root) return;
    writeSavedTabs(root, {
      files: this.tabs
        .map((tab) => tab.path)
        .slice(0, RESTORE_MAX_TABS),
      active: this.activePath,
    });
  }

  // ------------------------------------------------------------ open/activate

  async openFile(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.tabByPath(normalized);
    if (existing) {
      // Re-opening an existing tab (tree click, Quick Open) is an "open",
      // not a tab-bar focus — the outline must not scroll.
      this.activateTab(normalized, "open");
      return;
    }
    const bridge = window.jellybot;
    if (!bridge?.readFileForEditor) {
      this.setNotice("Bridge unavailable");
      return;
    }
    let result: Awaited<ReturnType<typeof bridge.readFileForEditor>>;
    try {
      result = await bridge.readFileForEditor(normalized);
    } catch (err) {
      this.setNotice(
        `Could not open — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!result.ok) {
      this.setNotice(`Could not open — ${result.message}`);
      return;
    }

    const info = languageForPath(normalized);
    const tab: EditorTab = {
      path: normalized,
      label: baseNameOf(normalized),
      languageId: info.languageId,
      model: null,
      pendingContent: result.content,
      baseContent: result.content,
      savedContent: result.content,
      dirty: false,
      readOnly: result.encoding === "non-utf8",
      hadBom: result.encoding === "utf8-bom",
      status: "ok",
      viewState: null,
      vcsDiff: null,
      annotated: false,
      blame: null,
      blameKind: null,
    };
    this.tabs.push(tab);
    // Click-to-open: the newly opened tab becomes active immediately.
    this.activePath = normalized;
    this.options?.onActiveTabChanged?.(normalized, "open");
    this.renderTabs();
    this.playTabEnter(normalized);
    this.setNotice(null);
    this.scheduleTabSave();

    await this.ensureMonaco();
    this.materializePendingTabs();
    this.attachActive();
    this.scheduleVcsDiff(normalized, 300);
  }

  /**
   * Open a file the agent just wrote/patched (write_file / patch finished).
   * Caps the strip at AGENT_OPEN_MAX_TABS: before a NEW tab is created the
   * oldest clean, non-active tab is evicted (dirty tabs never close
   * silently; when all candidates are dirty the open proceeds unevicted).
   * Editor focus is suppressed for the whole open so the chat composer
   * keeps its caret — the user is usually mid-conversation.
   */
  async openAgentFile(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.tabByPath(normalized);
    if (
      existing === null &&
      this.tabs.length >= AGENT_OPEN_MAX_TABS
    ) {
      const victim = pickAgentEvictionVictim(this.tabs, this.activePath);
      if (victim !== null) this.disposeTab(victim);
    }
    this.suppressEditorFocus = true;
    try {
      if (existing) {
        // The tab predates the write — its model still holds the
        // pre-patch content. Pull the post-patch bytes NOW: the disk
        // watcher's 120ms coalesced reload would lose the race with
        // flashLineRanges and paint the wash on stale lines (the ranges
        // are new-file coordinates). Clean tabs reload silently; dirty
        // ones go through the merge3 path, same as the watcher.
        this.activateTab(normalized, "open");
        await this.reloadFromDisk(normalized);
      } else {
        await this.openFile(path);
      }
    } finally {
      this.suppressEditorFocus = false;
    }
  }

  /**
   * Double-click a C++ tab → hop to its header/implementation counterpart.
   * Counterpart already open → activate that tab. Not open → replace this
   * tab in place (same slot) with the counterpart file. No counterpart on
   * disk → transient notice; nothing moves. A dirty original keeps its
   * discard gate: cancel leaves everything untouched.
   */
  private async toggleCounterpartTab(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const tab = this.tabByPath(normalized);
    if (!tab) return;
    // Resolution order: exact sibling candidates, then the loaded Quick
    // Open file index (the tier that reliably lists engine sources — the
    // same data Ctrl+T searches), then the scoped module-root walk.
    // See cppCounterpart.ts.
    const trace: string[] = [];
    try {
      const target = await resolveCppCounterpart(
        normalized,
        (root, query, options) =>
          window.jellybot?.searchDevModeFiles?.(root, query, options),
        (paths) => window.jellybot?.filterExistingFiles?.(paths),
        (base) => this.options?.queryFileIndex?.(base) ?? null,
        (line) => trace.push(line),
      );
      if (!target) {
        const bridgeOk = typeof window.jellybot?.searchDevModeFiles === "function";
        console.warn(
          `[CounterpartDbg] no counterpart for ${normalized}\n  ${trace.join("\n  ")}`,
        );
        this.setNotice(
          `[CounterpartDbg] no counterpart for ${tab.label} (bridge:${bridgeOk}) — see console`,
          8000,
        );
        return;
      }
      const open = this.tabByPath(target);
      console.warn(
        `[CounterpartDbg] ${normalized} -> target=${target} openTab=${open ? open.path : "none"}\n  ${trace.join("\n  ")}`,
      );
      // Counterpart already open → hop to that tab.
      if (open && open.path !== normalized) {
        this.activateTab(open.path);
        return;
      }
      // Not open — replace this tab in place with the counterpart file.
      await this.replaceTabWith(normalized, normalizePath(target));
    } catch (err) {
      console.warn("[CounterpartDbg] toggle threw:", err, trace.join(" | "));
      this.setNotice(`[CounterpartDbg] threw: ${String(err)}`, 8000);
    }
  }

  /**
   * Swap one tab's file for another in the same strip slot. The dirty gate
   * runs before anything moves; an openFile failure (its notice explains)
   * aborts the swap with the original tab intact.
   */
  private async replaceTabWith(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const old = this.tabByPath(oldPath);
    if (!old) return;
    if (
      old.dirty &&
      !window.confirm(`"${old.label}" has unsaved changes. Close and discard?`)
    ) {
      return;
    }
    const index = this.tabs.findIndex((t) => t.path === oldPath);
    if (index === -1) return;
    await this.openFile(newPath);
    const from = this.tabs.findIndex((t) => t.path === newPath);
    if (from === -1) return; // open failed — keep the original tab
    if (from > index) {
      // Rehome the freshly appended tab into the original's slot so the
      // switch reads as an in-place morph, not strip churn.
      const moved = this.tabs.splice(from, 1)[0];
      if (moved) {
        this.tabs.splice(index, 0, moved);
        this.renderTabs();
      }
    }
    this.disposeTab(oldPath);
  }

  /**
   * Agent line flash (read_file blue / patch add green / del red): a
   * one-shot ~1.5s wash over the given ranges, applied right after the
   * open that carries it. Skipped unless the file is the active tab (an
   * open activates it; a user racing the chain would not see the flash
   * anyway). The timer clears the decorations once the animation ends —
   * the CSS class carries the fade, this just reclaims the DOM.
   */
  flashLineRanges(
    path: string,
    ranges: readonly AgentFlashRange[],
  ): void {
    const tab = this.tabByPath(normalizePath(path));
    if (!this.editor || !this.monaco || !tab?.model) return;
    if (normalizePath(tab.path) !== normalizePath(this.activePath ?? "")) return;
    const lineCount = tab.model.getLineCount();
    const plan = normalizeFlashRanges(ranges, lineCount);
    if (plan.length === 0) return;
    if (!this.flashCollection) {
      this.flashCollection = this.editor.createDecorationsCollection();
    }
    this.flashCollection.set(
      plan.map((range) => ({
        range: new this.monaco!.Range(range.start, 1, range.end, 1),
        options: {
          isWholeLine: true,
          className: `devmode-flash-${range.kind}`,
        },
      })),
    );
    // Scroll the touched span into view — Smooth animates the ride (the
    // user asked for a transition on the jump); reduced-motion users get
    // the immediate jump. First range centers: with scattered hunks the
    // flash covers the rest, the viewport should land on the first one.
    const first = plan[0]!;
    this.editor.revealLinesInCenter(
      first.start,
      first.end,
      this.motionReduced()
        ? this.monaco.editor.ScrollType.Immediate
        : this.monaco.editor.ScrollType.Smooth,
    );
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.flashCollection?.clear();
    }, FLASH_CLEAR_MS);
  }

  // ------------------------------------------------------------- tab motion

  private motionReduced(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /**
   * Agent whole-file write opened this file — one green pulse on its tab
   * label (the content wash is flashLineRanges' job). Reduced-motion and
   * missing tabs are silent no-ops.
   */
  pulseTab(path: string): void {
    if (this.motionReduced()) return;
    const el = this.tabElFor(normalizePath(path));
    if (!el) return;
    el.classList.remove("is-written");
    void el.offsetWidth; // restart the keyframes on repeat writes
    el.classList.add("is-written");
    el.addEventListener(
      "animationend",
      () => el.classList.remove("is-written"),
      { once: true },
    );
  }

  private tabElFor(path: string): HTMLElement | null {
    return this.tabScroller.querySelector<HTMLElement>(
      `.devmode-tab[data-path="${CSS.escape(path)}"]`,
    );
  }

  /** Fresh tab slides in. Skipped during session restore (tab bursts). */
  private playTabEnter(path: string): void {
    if (this.restoringTabs || this.motionReduced()) return;
    const el = this.tabElFor(path);
    if (!el) return;
    el.classList.add("is-entering");
    el.addEventListener(
      "animationend",
      () => el.classList.remove("is-entering"),
      { once: true },
    );
  }

  private activateTab(path: string, source: TabActivationSource = "tab"): void {
    if (this.activePath === path) return;
    this.activePath = path;
    this.options?.onActiveTabChanged?.(path, source);
    this.attachActive();
    this.renderTabs();
    this.renderStatus();
    this.scheduleTabSave();
  }

  // ---------------------------------------------------------------- monaco

  private ensureMonaco(): Promise<void> {
    if (this.monaco) return Promise.resolve();
    if (!this.monacoPromise) {
      this.emptyTitle.textContent = "Loading editor…";
      this.emptyHint.textContent = "";
      this.monacoPromise = loadMonaco()
        .then((monaco) => {
          this.monaco = monaco;
          this.emptyTitle.textContent = "No file open";
          this.emptyHint.textContent =
            "Pick a file from the Solution Outline to view and edit it here.";
          this.createEditor();
        })
        .catch((err: unknown) => {
          this.monacoPromise = null;
          this.emptyTitle.textContent = "Editor failed to load";
          this.emptyHint.textContent =
            err instanceof Error ? err.message : String(err);
        });
    }
    return this.monacoPromise;
  }

  private createEditor(): void {
    if (!this.monaco || this.editor) return;
    const monaco = this.monaco;
    this.diffController.setMonaco(monaco);
    // Single source of truth for the host background (incl. the 10px left
    // padding gap) — keep it identical to the Monaco gutter color.
    this.editorHost.style.setProperty("--devmode-editor-bg", DEV_MODE_EDITOR_BG);
    this.editor = monaco.editor.create(this.editorHost, {
      value: "",
      language: "plaintext",
      theme: resolveDevModeTheme(),
      automaticLayout: true,
      fontFamily:
        'ui-monospace, "SF Mono", "JetBrains Mono Var", SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 12.5,
      minimap: { enabled: this.minimapEnabled },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      glyphMargin: true,
      lineNumbersMinChars: PLAIN_LINE_NUMBER_MIN_CHARS,
      lineDecorationsWidth: PLAIN_LINE_DECORATIONS_WIDTH,
      links: true,
      // `.`/`->`/`::`/`#include <` must ask the registered providers for
      // suggestions — monaco defaults this to false, which silently kills
      // the clangd completion layer on member access.
      suggestOnTriggerCharacters: true,
      // Suggest as you type identifiers (Rider-like), including inside an
      // inserted call snippet `Foo(|)` — monaco suppresses that by default.
      quickSuggestions: { other: "on", comments: "off", strings: "off" },
      quickSuggestionsDelay: 10,
      // Suggest rows: roomier than Monaco's ~19px default. The virtual list
      // sizes rows from this value, so spacing must be set here, not in CSS
      // (devmode.css only insets the row highlight inside these 28px).
      suggestLineHeight: 28,
      suggestFontSize: 12.5,
      suggest: {
        snippetsPreventQuickSuggestions: false,
        localityBonus: true,
        showStatusBar: false,
      },
      parameterHints: { enabled: true, cycle: true },
      // Bracket pairs (`(` `[` `{` quotes) close as you type, typing the
      // closer steps over it, Backspace in `(|)` removes both, a selection
      // gets wrapped; Enter between `{}` opens an indented block.
      autoClosingBrackets: "languageDefined",
      autoClosingQuotes: "languageDefined",
      autoClosingOvertype: "always",
      autoClosingDelete: "always",
      autoSurround: "languageDefined",
      autoIndent: "full",
    });
    // ESC while editing closes a lingering find widget (Ctrl+F) instead of
    // being swallowed — matches the IDE behavior users expect.
    this.editor.addCommand(monaco.KeyCode.Escape, () => {
      const controller = (
        this.editor as unknown as {
          getContribution?: (id: string) => unknown;
        }
      ).getContribution?.("editor.contrib.findController") as {
        closeFindWidget?: () => void;
      } | null;
      controller?.closeFindWidget?.();
    });
    // Ctrl+Space forces a fresh completion request (Rider "Basic
    // completion"); the providers treat it as an explicit invoke. macOS uses
    // ⌃Space because ⌘Space is Spotlight.
    const isMac = window.jellybot?.platform === "darwin";
    this.editor.addCommand(
      (isMac ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd) | monaco.KeyCode.Space,
      () => {
        this.editor?.trigger("keyboard", "editor.action.triggerSuggest", {});
      },
    );
    this.editorOpener?.dispose();
    this.editorOpener = monaco.editor.registerEditorOpener({
      openCodeEditor: (_source, resource, selectionOrPosition) => {
        const target = definitionTargetFromOpener(
          resource,
          selectionOrPosition,
        );
        if (!target) return false;
        void this.revealFileLine(target.path, target.line, target.column);
        return true;
      },
    });
    // Unreal C++ language pack: F12 / Ctrl+click and hovers read the
    // on-disk symbol database, then rank with the live buffer.
    this.cppFeatures?.dispose();
    this.cppFeatures = registerCppLanguageFeatures(
      { languages: monaco.languages, Uri: monaco.Uri },
      {
        lookupSymbols: async (word) => {
          const root = this.options?.getWorkspaceRoot?.();
          if (!root) return [];
          try {
            return (await window.jellybot?.lookupCppSymbols?.(root, word)) ?? [];
          } catch {
            return [];
          }
        },
        getWorkspaceRoot: () => this.options?.getWorkspaceRoot?.() ?? null,
        // Engine-type fallback (FVector, AActor…): resolve <install>/Engine
        // once per workspace, then read engine headers to locate the decl.
        getEngineRoot: async () => {
          const root = this.options?.getWorkspaceRoot?.();
          if (!root) return null;
          try {
            return (await window.jellybot?.getDevModeEngineRoot?.(root)) ?? null;
          } catch {
            return null;
          }
        },
        readEngineTextFile: async (path) => {
          const res = await window.jellybot?.readTextFile?.(path);
          return res?.ok ? res.content : null;
        },
      },
    );
    // clangd semantic layer (compiler-accurate completion / hover /
    // signature help) — silently absent when the workspace has no
    // compile_commands.json; the cppSymbols providers stay as fallback.
    this.clangdProviders?.dispose();
    this.clangdProviders = registerClangdProviders(
      {
        languages: monaco.languages,
        editor: monaco.editor as NonNullable<ClangdMonacoLike["editor"]>,
      },
      {
        getWorkspaceRoot: () => this.options?.getWorkspaceRoot?.() ?? null,
      },
    );
    if (this.options?.onDebugHover && this.options.onDebugVariables) {
      this.debugHoverView = new DebugHoverView(
        monaco,
        this.editor,
        new DebugHoverController(
          this.options.onDebugHover,
          this.options.onDebugVariables,
        ),
      );
    }
    this.editor.onMouseDown((event) => {
      if (
        !this.monaco ||
        event.target.type !==
          this.monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        !event.target.position
      ) {
        return;
      }
      const tab = this.activeTab();
      if (!tab || !this.debugEnabled) return;
      const line = event.target.position.lineNumber;
      if (event.event.rightButton || event.event.altKey) {
        event.event.preventDefault();
        this.options?.onBreakpointCondition?.(tab.path, line);
        return;
      }
      if (event.event.leftButton) {
        this.options?.onBreakpointToggle?.(tab.path, line);
      }
    });
    this.editor.onContextMenu((event) => {
      if (
        !this.monaco ||
        event.target.type !==
          this.monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
      ) {
        return;
      }
      event.event.preventDefault();
      event.event.stopPropagation();
    });
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => void this.saveActive(),
    );
    // Custom ⌘F find widget — block the built-in one (window-level keydown
    // in DevModeController routes the gesture to FindWidgetController).
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
      () => undefined,
    );
    // Same panel's replace row (Ctrl+H / ⌘⌥F). Do not bind Cmd+H on macOS
    // — that is Hide Window.
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
      () => undefined,
    );
    if (window.jellybot?.platform !== "darwin") {
      this.editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH,
        () => undefined,
      );
    }
    // F12 is parked in main (blocks DevTools) and forwarded over IPC;
    // this binding covers the same command if the key ever reaches Monaco.
    this.editor.addCommand(monaco.KeyCode.F12, () => this.goToDefinition());
    // Alt+F12 (Monaco's native peek-definition widget) routes to our own
    // go-to-definition flow — every language, never the built-in panel.
    this.editor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.F12,
      () => this.goToDefinition(),
    );
    this.editor.addAction({
      id: "jellybot.cpp.findUsages",
      label: "Find Usages",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.6,
      run: () => this.options?.onFindUsages?.(),
    });
    this.blameHover.bind(this.editor, monaco, () => {
      const tab = this.activeTab();
      if (
        this.diffController.isEnabled ||
        !tab?.annotated ||
        !tab.blame ||
        !tab.blameKind
      ) {
        return null;
      }
      return {
        kind: tab.blameKind,
        lines: tab.blame,
      };
    });
    this.editor.onDidChangeModelContent(() => {
      this.options?.onDocumentChanged?.();
    });
    this.editor.onDidChangeCursorPosition((event) => {
      this.options?.onCursorLineChanged?.(event.position.lineNumber);
    });
  }

  private materializePendingTabs(): void {
    if (!this.monaco) return;
    const monaco = this.monaco;
    for (const tab of this.tabs) {
      if (tab.model || tab.pendingContent === null) continue;
      let uri: MonacoTypes.Uri | undefined;
      try {
        uri = monaco.Uri.file(tab.path);
      } catch {
        uri = undefined; // duplicate/odd path — untitled model is fine
      }
      const model =
        uri !== undefined
          ? monaco.editor.createModel(
              tab.pendingContent,
              tab.languageId,
              uri,
            )
          : monaco.editor.createModel(tab.pendingContent, tab.languageId);
      tab.pendingContent = null;
      tab.model = model;
      model.onDidChangeContent(() => {
        const dirty = model.getValue() !== tab.savedContent;
        if (dirty !== tab.dirty) {
          tab.dirty = dirty;
          this.renderTabs();
          this.renderStatus();
        }
      });
    }
  }

  /** Fire-and-forget clangd didOpen for the attached file (preamble warm). */
  private warmClangdDocument(path: string, text: string): void {
    if (!/\.(?:c|h|cpp|hpp|hxx|cc|cxx|inl)$/i.test(path)) return;
    const root = this.options?.getWorkspaceRoot?.();
    if (!root) return;
    const bridge = window.jellybot;
    if (!bridge?.clangdDocChanged) return;
    void bridge.clangdDocChanged(root, path, text).catch(() => {});
  }

  private attachActive(): void {
    const tab = this.activeTab();
    if (!this.editor) return;
    // Preserve the outgoing tab's cursor/scroll.
    if (this.attachedPath && this.attachedPath !== tab?.path) {
      const outgoing = this.tabByPath(this.attachedPath);
      if (outgoing?.model) {
        outgoing.viewState = this.editor.saveViewState();
      }
    }
    this.attachedPath = tab?.path ?? null;
    if (!tab || !tab.model) {
      this.editor.setModel(null);
      void this.diffController.attach(null);
      this.updateEditorToggles();
      this.options?.onDocumentChanged?.();
      return;
    }
    // clangd warm-up: didOpen the attached file so its preamble builds in
    // the background — the first F12/completion on it is then instant.
    this.warmClangdDocument(tab.path, tab.model.getValue());
    this.editor.setModel(tab.model);
    if (tab.viewState) this.editor.restoreViewState(tab.viewState);
    this.editor.updateOptions({ readOnly: tab.readOnly });
    if (this.diffController.isEnabled) {
      void this.diffController.attach(this.diffDocument(tab));
    } else if (!this.suppressEditorFocus) {
      this.editor.focus();
    }
    this.applyVcsDecorations();
    this.applyDebugDecorations();
    this.applyDebugExecutionDecoration();
    this.applyDebugFrameDecoration();
    this.applyLineNumberMode();
    this.updateEditorToggles();
    this.options?.onDocumentChanged?.();
    const cursor = this.editor.getPosition();
    if (cursor) this.options?.onCursorLineChanged?.(cursor.lineNumber);
  }

  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
    this.applyDebugDecorations();
  }

  // ------------------------------------------------ launch cluster state
  // Build/Debug/config buttons on the tab bar — state driven by
  // DevModeController (task config loads + run lifecycle events).

  /** Build button run state: spinner while running, red pip on failure. */
  setBuildState(running: boolean, failed: boolean): void {
    this.buildButton.classList.toggle("is-running", running);
    this.buildButton.classList.toggle("is-failed", failed);
  }

  /** Deploy exists only when the workspace config defines tasks.deploy. */
  setDeployCommand(command: string | null): void {
    this.deployButton.hidden = command === null;
    this.deployButton.disabled = command === null;
    this.deployButton.title = command ? `Deploy — ${command}` : "Deploy";
  }

  setDeployState(running: boolean, failed: boolean): void {
    this.deployButton.classList.toggle("is-running", running);
    this.deployButton.classList.toggle("is-failed", failed);
  }

  setBuildTitle(title: string): void {
    this.buildButton.title = title;
  }

  /** Debug launch button — title from the recipe, enabled when supported. */
  setDebugRecipe(kind: DebugRecipe | null): void {
    this.debugLaunchButton.title = debugButtonTitle(kind);
    this.debugLaunchButton.disabled = kind === null;
  }

  /** Task-config gear — hidden on Unreal (UBT owns the build surface). */
  setConfigVisible(visible: boolean): void {
    this.configButton.hidden = !visible;
  }

  setDebugBreakpoints(
    breakpoints: Map<string, Map<number, BreakpointValue>>,
  ): void {
    this.debugBreakpoints = new Map(
      [...breakpoints].map(([path, lines]) => [
        normalizePath(path),
        new Map(lines),
      ]),
    );
    this.applyDebugDecorations();
  }

  setDebugExecutionLocation(path: string, line: number): void;
  setDebugExecutionLocation(path: null, line?: undefined): void;
  setDebugExecutionLocation(path: string | null, line?: number): void {
    this.debugExecutionLocation =
      path && line && line > 0
        ? { path: normalizePath(path), line }
        : null;
    this.applyDebugExecutionDecoration();
  }

  setDebugFrameLocation(path: string, line: number): void;
  setDebugFrameLocation(path: null, line?: undefined): void;
  setDebugFrameLocation(path: string | null, line?: number): void {
    this.debugFrameLocation =
      path && line && line > 0
        ? { path: normalizePath(path), line }
        : null;
    this.applyDebugFrameDecoration();
  }

  private applyDebugExecutionDecoration(): void {
    if (!this.editor || !this.monaco) return;
    if (!this.debugExecutionCollection) {
      this.debugExecutionCollection =
        this.editor.createDecorationsCollection();
    }
    const tab = this.activeTab();
    const location = this.debugExecutionLocation;
    if (
      !tab?.model ||
      !location ||
      normalizePath(tab.path).toLowerCase() !== location.path.toLowerCase()
    ) {
      this.debugExecutionCollection.set([]);
      return;
    }
    const line = Math.min(location.line, tab.model.getLineCount());
    this.debugExecutionCollection.set([
      {
        range: new this.monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "devmode-debug-current-line",
          glyphMarginClassName: "devmode-debug-current-arrow",
          overviewRuler: {
            color: "#d6a94a",
            position: this.monaco.editor.OverviewRulerLane.Full,
          },
        },
      },
    ]);
  }

  /** Selected call-stack frame: green arrow + wash, like VS Code's. */
  private applyDebugFrameDecoration(): void {
    if (!this.editor || !this.monaco) return;
    if (!this.debugFrameCollection) {
      this.debugFrameCollection = this.editor.createDecorationsCollection();
    }
    const tab = this.activeTab();
    const location = this.debugFrameLocation;
    if (
      !tab?.model ||
      !location ||
      normalizePath(tab.path).toLowerCase() !== location.path.toLowerCase()
    ) {
      this.debugFrameCollection.set([]);
      return;
    }
    const line = Math.min(location.line, tab.model.getLineCount());
    this.debugFrameCollection.set([
      {
        range: new this.monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "devmode-debug-frame-line",
          glyphMarginClassName: "devmode-debug-frame-arrow",
          overviewRuler: {
            color: "#57ab5a",
            position: this.monaco.editor.OverviewRulerLane.Full,
          },
        },
      },
    ]);
  }

  private applyDebugDecorations(): void {
    if (!this.editor || !this.monaco) return;
    const tab = this.activeTab();
    if (!tab?.model) {
      this.debugCollection?.clear();
      return;
    }
    if (!this.debugEnabled) {
      this.debugCollection?.clear();
      return;
    }
    const lines =
      this.debugBreakpoints.get(normalizePath(tab.path)) ?? new Map();
    const decorations: MonacoTypes.editor.IModelDeltaDecoration[] = [
      ...lines,
    ].map(([line, value]) => {
      const text = value.condition.trim();
      const conditional = text.length > 0;
      const enabled = value.enabled;
      return {
        range: new this.monaco!.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: [
            "devmode-debug-breakpoint",
            conditional ? "is-conditional" : "",
            enabled ? "" : "is-disabled",
          ]
            .filter(Boolean)
            .join(" "),
          marginClassName: enabled
            ? "devmode-debug-bp-ln"
            : "devmode-debug-bp-ln is-disabled",
          glyphMarginHoverMessage: {
            value: enabled
              ? conditional
                ? `Break when ${text.replace(/`/g, "'")}`
                : `Breakpoint at line ${line}`
              : `Disabled breakpoint at line ${line}`,
          },
        },
      };
    });
    if (!this.debugCollection) {
      this.debugCollection = this.editor.createDecorationsCollection(decorations);
    } else {
      this.debugCollection.set(decorations);
    }
  }

  // ---------------------------------------------------------------- close/save

  /**
   * Close one tab — the dirty discard gate lives here. Returns whether a
   * close was initiated (a canceled discard prompt returns false).
   */
  private closeTab(path: string): boolean {
    const tab = this.tabByPath(path);
    if (!tab) return false;
    if (tab.dirty) {
      const ok = window.confirm(
        `"${tab.label}" has unsaved changes. Close and discard?`,
      );
      if (!ok) return false;
    }
    return this.requestClose(path);
  }

  /**
   * ⌘W / Ctrl+F4: close the active file tab (its X-click equivalent).
   * While earlier closes animate out, each press advances down the
   * takeover chain — the tab that will inherit the active slot — so
   * mashing closes one tab per press. Returns false only when the tab
   * bar is empty and the caller should close the window instead.
   */
  closeActiveTab(): boolean {
    if (this.tabs.length === 0) return false;
    let target: EditorTab | null = this.activeTab() ?? this.tabs[0]!;
    const seen = new Set<string>();
    while (target && this.isClosing(target.path)) {
      if (seen.has(target.path)) {
        target = null;
        break;
      }
      seen.add(target.path);
      target = this.tabSuccessor(target.path);
    }
    if (!target) return true; // burst outran the motions — swallow it
    this.closeTab(target.path);
    return true;
  }

  /** Tab that inherits the active slot when `path` goes away (array order). */
  private tabSuccessor(path: string): EditorTab | null {
    const index = this.tabs.findIndex((tab) => tab.path === path);
    if (index === -1) return null;
    return this.tabs[index + 1] ?? this.tabs[index - 1] ?? null;
  }

  private isClosing(path: string): boolean {
    return path === this.closingPath || this.pendingCloses.includes(path);
  }

  /**
   * Close motions are serialized: renderTabs() rebuilds the whole strip,
   * which would tear a sibling's in-flight animation — park instead.
   */
  private requestClose(path: string): boolean {
    if (path === this.closingPath) return true;
    if (this.closingPath !== null) {
      if (!this.pendingCloses.includes(path)) this.pendingCloses.push(path);
      return true;
    }
    this.disposeTabAnimated(path);
    return true;
  }

  /**
   * Single-close animation: the tab shrinks + fades away while its neighbors
   * glide in (flex reflows as the width eases); state lands on dispose.
   * Batch closes (Close Others / All) skip this and dispose immediately.
   */
  private disposeTabAnimated(path: string): void {
    const el = this.tabElFor(path);
    if (!el || this.motionReduced()) {
      this.disposeTab(path);
      this.drainCloseQueue();
      return;
    }
    // Active tab: preview the neighbor highlight during the shrink.
    if (el.classList.contains("is-active")) {
      const neighbor =
        el.nextElementSibling instanceof HTMLElement &&
        el.nextElementSibling.classList.contains("devmode-tab")
          ? el.nextElementSibling
          : el.previousElementSibling instanceof HTMLElement &&
              el.previousElementSibling.classList.contains("devmode-tab")
            ? el.previousElementSibling
            : null;
      if (neighbor) {
        el.classList.remove("is-active");
        neighbor.classList.add("is-active");
      }
    }
    el.classList.add("is-leaving");
    el.style.width = `${el.offsetWidth}px`;
    el.style.minWidth = "0";
    void el.offsetWidth; // pin the start width before collapsing
    el.style.width = "0px";
    this.closingPath = path;
    window.setTimeout(() => {
      this.disposeTab(path);
      this.closingPath = null;
      this.drainCloseQueue();
    }, 170);
  }

  /** Run the next parked close — animates on the freshly rebuilt strip. */
  private drainCloseQueue(): void {
    const next = this.pendingCloses.shift();
    if (next !== undefined) this.disposeTabAnimated(next);
  }

  private closeOtherTabs(keepPath: string): void {
    this.closeTabsExcept(keepPath);
  }

  private closeAllTabs(): void {
    this.closeTabsExcept(null);
  }

  /** Batch close with ONE confirmation across all dirty tabs. */
  private closeTabsExcept(keep: string | null): void {
    const closing = this.tabs.filter((tab) => tab.path !== keep);
    if (closing.length === 0) return;
    const dirty = closing.filter((tab) => tab.dirty).length;
    if (dirty > 0) {
      const what =
        dirty === 1
          ? "1 tab has unsaved changes"
          : `${dirty} tabs have unsaved changes`;
      if (!window.confirm(`${what}. Close and discard?`)) return;
    }
    for (const tab of closing) this.disposeTab(tab.path);
    // The batch decision supersedes any parked single closes — a queued
    // path could otherwise fire later and take out the kept tab.
    this.pendingCloses.length = 0;
    if (keep !== null) this.activateTab(keep); // no-op when already active
  }

  /** Remove a tab for real — dirty confirmation is the caller's gate. */
  private disposeTab(path: string): void {
    const index = this.tabs.findIndex((tab) => tab.path === path);
    if (index === -1) return;
    const tab = this.tabs[index]!;
    if (this.reloadTimers.has(path)) {
      window.clearTimeout(this.reloadTimers.get(path)!);
      this.reloadTimers.delete(path);
    }
    const vcsTimer = this.vcsDiffTimers.get(path);
    if (vcsTimer !== undefined) {
      window.clearTimeout(vcsTimer);
      this.vcsDiffTimers.delete(path);
    }
    if (this.activePath === path && this.diffController.isEnabled) {
      void this.diffController.attach(null);
    }
    tab.model?.dispose();
    this.tabs.splice(index, 1);
    if (this.tabs.length === 0) this.diffController.disable();
    if (this.attachedPath === path) this.attachedPath = null;
    if (this.activePath === path) {
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activePath = next?.path ?? null;
      // The successor now fills the editor — the tree should land on it
      // (expand → select → center), same as clicking its tab. Burst closes
      // supersede: revealPath's seq guard aborts the stale walks.
      if (next) this.options?.onActiveTabChanged?.(next.path, "close");
      this.attachActive();
    }
    this.renderTabs();
    this.renderStatus();
    this.scheduleTabSave();
  }

  private async saveActive(): Promise<void> {
    const tab = this.activeTab();
    if (!tab || tab.readOnly || !tab.dirty) return;
    const bridge = window.jellybot;
    if (!bridge?.writeTextFile || !tab.model) return;
    const value = tab.model.getValue();
    const result = await bridge.writeTextFile(
      tab.path,
      value,
      tab.hadBom,
    );
    if (!result.ok) {
      this.setNotice(`Save failed — ${result.message}`, 6000);
      return;
    }
    tab.savedContent = value;
    tab.baseContent = value;
    tab.status = "ok";
    tab.dirty = false;
    this.renderTabs();
    this.renderStatus();
    this.setNotice("Saved", 1500);
    // Content changed → gutter marks may have changed (M persists, lines shift).
    this.scheduleVcsDiff(tab.path, 600);
    this.refreshAnnotate(tab.path);
  }

  // ------------------------------------------------------------- fs events

  handleFsEvent(payload: {
    events: Array<{ path: string; kind: string }>;
  }): void {
    for (const event of payload.events) {
      const tab = this.tabByPath(event.path);
      if (!tab) continue;
      if (event.kind === "unlink") {
        tab.status = "deleted";
        this.renderTabs();
        this.renderStatus();
        continue;
      }
      if (event.kind === "change" || event.kind === "add") {
        this.queueDiskReload(tab.path);
      }
    }
  }

  /** Coalesce bursts (agent write loops) into one trailing disk read. */
  private queueDiskReload(path: string): void {
    const existing = this.reloadTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.reloadTimers.set(
      path,
      window.setTimeout(() => {
        this.reloadTimers.delete(path);
        void this.reloadFromDisk(path);
      }, RELOAD_COALESCE_MS),
    );
  }

  private async reloadFromDisk(path: string): Promise<void> {
    const tab = this.tabByPath(path);
    const bridge = window.jellybot;
    if (!tab || !bridge?.readFileForEditor) return;
    let result: Awaited<ReturnType<typeof bridge.readFileForEditor>>;
    try {
      result = await bridge.readFileForEditor(path);
    } catch {
      return;
    }
    if (!result.ok) return;
    this.applyDiskContent(tab, result.content);
    // Agent rewrote the file — refresh gutter marks.
    this.scheduleVcsDiff(path, 800);
    this.refreshAnnotate(path);
  }

  // ------------------------------------------------------------- vcs marks

  /** Outline refreshed its VCS state → refresh the active tab's gutter. */
  refreshVcsDecorations(): void {
    const tab = this.activeTab();
    if (tab) this.scheduleVcsDiff(tab.path, 100);
  }

  // ------------------------------------------------------------------- diff

  private diffDocument(tab: EditorTab): EditorDiffDocument {
    return {
      path: tab.path,
      languageId: tab.languageId,
      model: tab.model!,
      readOnly: tab.readOnly,
    };
  }

  private async toggleDiff(): Promise<void> {
    const tab = this.activeTab();
    if (!tab?.model) return;
    await this.diffController.toggle(this.diffDocument(tab));
  }

  // -------------------------------------------------------------- annotate

  /** Toggle blame labels for one tab (fab button / tab context menu). */
  private async toggleAnnotate(path: string): Promise<void> {
    const tab = this.tabByPath(path);
    if (!tab) return;
    if (tab.annotated) {
      tab.annotated = false;
      tab.blame = null;
      tab.blameKind = null;
      if (this.activePath === path) this.applyLineNumberMode(true);
      this.updateEditorToggles();
      this.renderStatus();
      return;
    }
    if (!(await this.fetchBlame(tab, false))) return;
    tab.annotated = true;
    if (this.activePath === path) this.applyLineNumberMode(true);
    this.updateEditorToggles();
    this.renderStatus();
  }

  /** Fetch blame into the tab. Silent failures keep the previous labels. */
  private async fetchBlame(tab: EditorTab, silent: boolean): Promise<boolean> {
    const bridge = window.jellybot;
    const root = this.options?.getWorkspaceRoot?.() ?? null;
    if (!root) {
      if (!silent) this.setNotice("Annotate needs a workspace root", 4000);
      return false;
    }
    if (!bridge?.annotateFile) {
      if (!silent) this.setNotice("Annotate unavailable in this build", 4000);
      return false;
    }
    if (!silent) this.setNotice("Annotating…");
    try {
      const result = await bridge.annotateFile(root, tab.path);
      if (!result.ok) {
        if (!silent) {
          this.setNotice(`Annotate failed — ${result.message}`, 6000);
        }
        return false;
      }
      tab.blame = result.lines;
      tab.blameKind = result.kind;
      if (!silent) this.setNotice(null);
      return true;
    } catch (err) {
      if (!silent) {
        const message = err instanceof Error ? err.message : String(err);
        this.setNotice(`Annotate failed — ${message}`, 6000);
      }
      return false;
    }
  }

  /** Keep an annotated gutter in sync after saves / agent writes. */
  private refreshAnnotate(path: string): void {
    const tab = this.tabByPath(path);
    if (!tab || !tab.annotated) return;
    void this.fetchBlame(tab, true).then((ok) => {
      if (!ok) return; // keep previous labels on failure
      if (this.activePath === tab.path) this.applyLineNumberMode();
    });
  }

  /**
   * Line-number column: plain numbers, or `<blame…> n` via Monaco's
   * per-line string callback when the active tab is annotated.
   */
  private applyLineNumberMode(animated = false): void {
    const editor = this.editor;
    if (!editor) return;
    const before = animated ? this.gutterWidthPx() : 0;
    const tab = this.activeTab();
    if (tab?.annotated && tab.blame && tab.blameKind) {
      const kind: BlameKind = tab.blameKind;
      const byLine = new Map(tab.blame.map((entry) => [entry.line, entry]));
      const total = tab.model?.getLineCount() ?? 1;
      const numWidth = String(total).length;
      const maxLabel = tab.blame.reduce(
        (max, entry) =>
          Math.max(
            max,
            blameLabelColumns(blameGutterLabel(entry, kind)),
          ),
        0,
      );
      editor.updateOptions({
        lineNumbers: (n: number) => {
          const entry = byLine.get(n);
          if (!entry) return String(n);
          // Blame LEFT of the number: the number column keeps its usual
          // right-aligned slot next to the code; blame hangs to its left.
          // The line-number box has a single line's height, so any wrap
          // inside it paints the tail over the next row (two authors on top
          // of each other) — NBSP keeps "Name 3d" on one line.
          const label = blameGutterLabel(entry, kind).replace(/ /g, "\u00a0");
          return `${label}\u00a0\u00a0${n}`;
        },
        // Two non-breaking spaces are visible separation; one extra character
        // of width prevents the age label and line number touching at zoom.
        lineNumbersMinChars: Math.min(48, numWidth + 3 + maxLabel),
        lineDecorationsWidth: BLAME_LINE_DECORATIONS_WIDTH,
        // Monaco's sticky copy duplicates the gutter at the top edge. With
        // blame labels that can look like two authors painted over each other.
        stickyScroll: { enabled: false },
      });
      this.applyBlameDecorations();
    } else {
      editor.updateOptions({
        lineNumbers: "on",
        lineNumbersMinChars: PLAIN_LINE_NUMBER_MIN_CHARS,
        lineDecorationsWidth: PLAIN_LINE_DECORATIONS_WIDTH,
        stickyScroll: { enabled: true },
      });
      this.blameCollection?.set([]);
    }
    if (animated) this.animateGutterShift(before);
  }

  /**
   * Blame toggle motion (FLIP): the gutter width jumps instantly inside
   * Monaco, so shift the two regions that jump — `.margin` and the
   * `.editor-scrollable` content window (both direct children of the
   * overflow guard) — back by the delta and ease them home.
   *
   * Not `.lines-content`: it sits INSIDE `.editor-scrollable`, whose
   * overflow:hidden window has already jumped to the new contentLeft;
   * shifting the child back left just clips the text out of the window
   * (it vanished, then slid back in — the whole area must move as one).
   */
  private animateGutterShift(before: number): void {
    const editor = this.editor;
    if (!editor || this.motionReduced()) return;
    editor.render(true); // flush the new layout so widths are measurable
    const guard =
      editor.getDomNode()?.querySelector<HTMLElement>(".overflow-guard") ??
      null;
    // Direct-children scan (avoid descendant hits inside widgets/minimap).
    const kids = guard ? Array.from(guard.children) : [];
    const margin =
      (kids.find((el) => el.classList.contains("margin")) as HTMLElement) ??
      null;
    const scrollable =
      (kids.find((el) =>
        el.classList.contains("editor-scrollable"),
      ) as HTMLElement) ?? null;
    const delta = this.gutterWidthPx() - before;
    if (!delta || !margin || !scrollable) return;
    const frames: Keyframe[] = [
      { transform: `translateX(${-delta}px)` },
      { transform: "translateX(0px)" },
    ];
    const opts: KeyframeAnimationOptions = { duration: 170, easing: "ease" };
    this.clipDuring([
      margin.animate(frames, opts),
      scrollable.animate(frames, opts),
    ]);
  }

  /** Rendered gutter width — equals layout `contentLeft` (the text offset). */
  private gutterWidthPx(): number {
    const margin =
      this.editor?.getDomNode()?.querySelector<HTMLElement>(".margin") ?? null;
    return margin ? margin.offsetWidth : 0;
  }

  /**
   * Per-line blame chrome: the full-note hover plus a colored band in the
   * lines-decorations lane, one color per revision, so consecutive lines from
   * the same commit read as one batch. Capped for big files.
   */
  private applyBlameDecorations(): void {
    const editor = this.editor;
    const monaco = this.monaco;
    if (editor && !this.blameCollection) {
      this.blameCollection = editor.createDecorationsCollection();
    }
    const tab = this.activeTab();
    if (
      !editor ||
      !monaco ||
      !this.blameCollection ||
      !tab?.model ||
      !tab.blame ||
      !tab.blameKind
    ) {
      this.blameCollection?.set([]);
      return;
    }
    const total = tab.model.getLineCount();
    if (
      tab.blame.length > BLAME_HOVER_MAX_LINES ||
      total > BLAME_HOVER_MAX_LINES
    ) {
      this.blameCollection.set([]);
      return;
    }
    const kind: BlameKind = tab.blameKind;
    const bands = blameBandSlots(tab.blame);
    const decos: MonacoTypes.editor.IModelDeltaDecoration[] = [];
    for (const entry of tab.blame) {
      if (entry.line < 1 || entry.line > total) continue;
      const slot = bands.get(entry.rev);
      decos.push({
        range: new monaco.Range(entry.line, 1, entry.line, 1),
        options: {
          isWholeLine: true,
          hoverMessage: { value: blameHoverText(entry, kind) },
          linesDecorationsClassName:
            slot === undefined
              ? "devmode-blame-band is-local"
              : `devmode-blame-band devmode-blame-band-${slot}`,
        },
      });
    }
    this.blameCollection.set(decos);
  }

  /** Sync the floating annotate toggle with the active tab's state. */
  private updateEditorToggles(): void {
    const active = this.activeTab();
    const annotated = Boolean(active?.annotated);
    this.annotateButton.disabled = active === null;
    this.annotateButton.classList.toggle("is-on", annotated);
    this.annotateButton.setAttribute("aria-pressed", String(annotated));
    const label = annotated ? "Stop annotating" : "Annotate (blame)";
    this.annotateButton.title = label;
    this.annotateButton.setAttribute("aria-label", label);

    const diff = this.diffController.isEnabled;
    this.diffButton.disabled = !active?.model;
    this.diffButton.classList.toggle("is-on", diff);
    this.diffButton.setAttribute("aria-pressed", String(diff));
    const diffLabel = diff ? "Hide side-by-side diff" : "Show side-by-side diff";
    this.diffButton.title = diffLabel;
    this.diffButton.setAttribute("aria-label", diffLabel);
  }

  /** Minimap is off by default; the floating Map button flips it. */
  private setMinimap(enabled: boolean): void {
    this.minimapEnabled = enabled;
    try {
      if (enabled) localStorage.setItem(MINIMAP_KEY, "1");
      else localStorage.removeItem(MINIMAP_KEY);
    } catch {
      // quota / private mode
    }
    const label = enabled ? "Hide minimap" : "Show minimap";
    this.minimapButton.title = label;
    this.minimapButton.setAttribute("aria-label", label);
    this.minimapButton.setAttribute("aria-pressed", String(enabled));
    this.minimapButton.classList.toggle("is-on", enabled);
    this.diffController.setMinimap(enabled);

    const editor = this.editor;
    const node =
      editor?.getDomNode()?.querySelector<HTMLElement>(".minimap") ?? null;
    this.minimapAnim?.cancel();
    this.minimapAnim = null;
    if (!editor || !node || this.motionReduced()) {
      editor?.updateOptions({ minimap: { enabled } });
      return;
    }

    if (enabled) {
      // Show: Monaco lays the strip out instantly — fade/slide it in from
      // the right edge to mask the viewport narrowing.
      editor.updateOptions({ minimap: { enabled: true } });
      editor.render(true); // paint the canvas before the entrance starts
      this.clipDuring([
        node.animate(
          [
            { opacity: 0, transform: "translateX(10px)" },
            { opacity: 1, transform: "translateX(0px)" },
          ],
          { duration: 170, easing: "ease" },
        ),
      ]);
      return;
    }
    // Hide: disabling collapses the canvas instantly, so the fade must
    // land first — the option flips in the finish handler.
    const anim = node.animate(
      [
        { opacity: 1, transform: "translateX(0px)" },
        { opacity: 0, transform: "translateX(10px)" },
      ],
      { duration: 150, easing: "ease", fill: "forwards" },
    );
    this.minimapAnim = anim;
    this.clipDuring([anim]);
    anim.onfinish = () => {
      if (this.minimapAnim !== anim) return; // superseded by a re-toggle
      this.minimapAnim = null;
      this.editor?.updateOptions({ minimap: { enabled: false } });
      anim.cancel(); // layout already removed it — drop the fill frame
    };
  }

  /**
   * Clip the editor host for the lifetime of a motion so sliding parts
   * (gutter, minimap) can't spill past the editor bounds mid-animation.
   * Transient on purpose: a permanent clip would cut Monaco popups.
   */
  private clipDuring(anims: Animation[]): void {
    const host = this.editorHost;
    host.classList.add("is-motion-clip");
    let pending = anims.length;
    const done = (): void => {
      pending -= 1;
      if (pending <= 0) host.classList.remove("is-motion-clip");
    };
    for (const anim of anims) anim.finished.then(done, done);
  }

  private scheduleVcsDiff(path: string, delayMs: number): void {
    const prev = this.vcsDiffTimers.get(path);
    if (prev !== undefined) window.clearTimeout(prev);
    this.vcsDiffTimers.set(
      path,
      window.setTimeout(() => {
        this.vcsDiffTimers.delete(path);
        void this.loadVcsDiff(path);
      }, delayMs),
    );
  }

  private async loadVcsDiff(path: string): Promise<void> {
    const bridge = window.jellybot;
    const root = this.options?.getWorkspaceRoot?.() ?? null;
    if (!bridge?.getVcsFileDiff || !root) return;
    try {
      const result = await bridge.getVcsFileDiff(root, path);
      const tab = this.tabByPath(path);
      if (!tab) return;
      if (!result.ok) return; // keep old marks on failure
      tab.vcsDiff = result.diff;
      if (this.activePath === path) this.applyVcsDecorations();
    } catch {
      // keep old marks
    }
  }

  /** Paint gutter bars + overview ruler marks for the active tab. */
  private applyVcsDecorations(): void {
    const editor = this.editor;
    const tab = this.activeTab();
    if (!editor) return;
    if (!this.vcsCollection) {
      this.vcsCollection = editor.createDecorationsCollection();
    }
    if (!tab || !tab.model || !tab.vcsDiff || !this.monaco) {
      this.vcsCollection.set([]);
      return;
    }
    const monaco = this.monaco;
    const total = tab.model.getLineCount();
    const decos: MonacoTypes.editor.IModelDeltaDecoration[] = [];

    const pushLine = (line: number, kind: "M" | "A"): void => {
      if (line < 1 || line > total) return;
      decos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          // Soft wash behind the line numbers only — number stays readable.
          marginClassName: kind === "M" ? "vcs-lnbg-modified" : "vcs-lnbg-added",
          overviewRuler: {
            color: kind === "M" ? "#d29922" : "#57ab5a",
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      });
    };

    const diff = tab.vcsDiff;
    if (diff.allAdded) {
      for (let i = 1; i <= total; i++) pushLine(i, "A");
    } else {
      for (const entry of diff.lines) pushLine(entry.line, entry.kind);
      for (const del of diff.deleted) {
        const line = Math.min(Math.max(1, del.beforeLine), total);
        decos.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            marginClassName: "vcs-lnbg-deleted",
            overviewRuler: {
              color: "#e5534b",
              position: monaco.editor.OverviewRulerLane.Left,
            },
          },
        });
      }
    }
    this.vcsCollection.set(decos);
  }

  private applyDiskContent(tab: EditorTab, disk: string): void {
    if (!tab.dirty) {
      // Clean buffer — silent reload as a single undoable edit.
      tab.baseContent = disk;
      tab.savedContent = disk;
      tab.status = "ok";
      if (tab.model) {
        if (tab.model.getValue() !== disk) tab.model.setValue(disk);
      } else {
        tab.pendingContent = disk;
      }
      this.renderTabs();
      this.renderStatus();
      return;
    }

    // Dirty buffer — three-way merge, agent wins collisions, one undoable
    // edit overall (Cmd+Z reverts the whole merge; plan decision #4).
    const mine = tab.model
      ? tab.model.getValue()
      : (tab.pendingContent ?? tab.savedContent);
    const result = merge3(tab.baseContent, mine, disk);
    tab.baseContent = disk;
    if (result.merged !== mine) {
      if (tab.model) {
        tab.model.pushEditOperations(
          [],
          [
            {
              range: tab.model.getFullModelRange(),
              text: result.merged,
            },
          ],
          () => null,
        );
      } else {
        tab.pendingContent = result.merged;
      }
    }
    const suffix =
      result.conflictCount > 0
        ? ` (${result.conflictCount} overwritten by agent edits — Cmd+Z to revert)`
        : "";
    this.setNotice(`Merged disk changes${suffix}`, 6000);
    this.renderStatus();
  }

  // ---------------------------------------------------------------- helpers

  private activeTab(): EditorTab | null {
    if (!this.activePath) return null;
    return this.tabByPath(this.activePath);
  }

  private tabByPath(path: string): EditorTab | null {
    const normalized = normalizePath(path);
    return this.tabs.find((tab) => tab.path === normalized) ?? null;
  }

  private setNotice(message: string | null, ttlMs?: number): void {
    this.notice = message;
    this.renderStatus();
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    if (message && ttlMs !== undefined) {
      this.noticeTimer = window.setTimeout(() => {
        this.notice = null;
        this.noticeTimer = null;
        this.renderStatus();
      }, ttlMs);
    }
  }

  // ----------------------------------------------------------------- render

  private renderTabs(): void {
    const scrollLeft = this.tabScroller.scrollLeft;
    this.tabScroller.replaceChildren();
    // Tab bar stays mounted even with zero tabs (controls live in it).
    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className = "devmode-tab";
      el.dataset.path = tab.path;
      el.classList.toggle("is-active", tab.path === this.activePath);
      el.classList.toggle("is-dirty", tab.dirty);
      el.classList.toggle("is-deleted", tab.status === "deleted");
      el.title = tab.path;
      if (tab.readOnly) el.title += " (read-only)";

      const label = document.createElement("span");
      label.className = "devmode-tab-label";
      label.textContent = tab.label;
      const langIcon = createLanguageIcon(languageForPath(tab.path).icon, createLucideIcon);
      const dot = document.createElement("span");
      dot.className = "devmode-tab-dot";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "devmode-tab-close";
      close.setAttribute("aria-label", `Close ${tab.label}`);
      close.append(createLucideIcon(X, { size: 12 }));
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        this.closeTab(tab.path);
      });
      el.append(langIcon, label, dot, close);
      el.addEventListener("click", () => {
        // Clicking the focused tab is a "find me in the tree" gesture —
        // activateTab short-circuits on it, so re-fire the reveal directly.
        // The tab may sit half-clipped after strip scrolling (or after
        // neighbors opened/closed), so re-center it first — scrollIntoView
        // with inline:"nearest" only moves when the tab is not fully in
        // view, keeping fully-visible clicks no-ops.
        if (this.activePath === tab.path) {
          this.revealActiveTab();
          this.options?.onActiveTabChanged?.(tab.path, "tab");
          return;
        }
        this.activateTab(tab.path);
      });
      el.addEventListener("auxclick", (event) => {
        if (event.button === 1) this.closeTab(tab.path);
      });
      // Double-click a C++ tab → hop to its header/implementation
      // counterpart (open → activate; single → replace this tab in place).
      el.addEventListener("dblclick", () => {
        void this.toggleCounterpartTab(tab.path);
      });
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        // Right-click targets what you see: activate first, then menu.
        if (this.activePath !== tab.path) this.activateTab(tab.path);
        this.openTabMenu(event, tab.path);
      });
      this.tabScroller.append(el);
    }
    this.tabScroller.scrollLeft = scrollLeft;
    this.editorHost.classList.toggle("is-visible", this.tabs.length > 0);
    this.emptyState.classList.toggle("is-visible", this.tabs.length === 0);
    this.revealActiveTab();
    this.updateTabNav();
    this.updateEditorToggles();
  }

  /** Tab context menu: Reveal / Close / Close Others / Close All / Annotate. */
  private openTabMenu(event: MouseEvent, path: string): void {
    const tab = this.tabByPath(path);
    if (!tab) return;
    const others = this.tabs.length - 1;
    const revealLabel =
      window.jellybot?.platform === "win32"
        ? "Show in Explorer"
        : "Reveal in Finder";
    showDevMenu(
      { x: event.clientX, y: event.clientY },
      [
        {
          label: "Reveal in File Tree",
          onSelect: () => this.options?.onRevealInTree?.(path),
        },
        {
          label: revealLabel,
          onSelect: () => {
            void window.jellybot?.revealPath(path);
          },
        },
        {
          label: "Copy Path",
          onSelect: () => {
            void navigator.clipboard.writeText(path);
          },
        },
        { kind: "sep" },
        { label: "Close", onSelect: () => this.closeTab(path) },
        {
          label: "Close Others",
          ...(others > 0 ? { hint: String(others) } : {}),
          disabled: others === 0,
          onSelect: () => this.closeOtherTabs(path),
        },
        {
          label: "Close All",
          disabled: this.tabs.length === 0,
          onSelect: () => this.closeAllTabs(),
        },
        { kind: "sep" },
        tab.annotated
          ? {
              label: "Stop Annotating",
              onSelect: () => void this.toggleAnnotate(path),
            }
          : {
              label: "Annotate (Blame)",
              onSelect: () => void this.toggleAnnotate(path),
            },
      ],
    );
  }

  /** Keep the active tab inside the visible window of the tab strip. */
  private revealActiveTab(): void {
    if (!this.activePath) return;
    const active = [...this.tabScroller.children].find(
      (child) =>
        child instanceof HTMLElement && child.classList.contains("is-active"),
    );
    if (active instanceof HTMLElement) {
      active.scrollIntoView({
        behavior: "smooth",
        inline: "nearest",
        block: "nearest",
      });
    }
  }

  /** Enable/disable the < > pagers; they appear only when tabs overflow. */
  private updateTabNav(): void {
    const max = this.tabScroller.scrollWidth - this.tabScroller.clientWidth;
    const overflow = max > 1;
    this.tabBar.classList.toggle("has-overflow", overflow);
    this.tabPrev.disabled = this.tabScroller.scrollLeft <= 0;
    this.tabNext.disabled = this.tabScroller.scrollLeft >= max - 1;
  }

  private scrollTabs(direction: 1 | -1): void {
    const step = Math.max(180, this.tabScroller.clientWidth * 0.7);
    this.tabScroller.scrollBy({
      left: direction * step,
      behavior: "smooth",
    });
  }

  private syncClangdProgressTimer(): void {
    const needsTick = clangdProgressNeedsTick(this.clangdProgress);
    if (needsTick && this.clangdProgressTimer === null) {
      this.clangdProgressTimer = window.setInterval(() => this.renderStatus(), 1000);
    } else if (!needsTick && this.clangdProgressTimer !== null) {
      window.clearInterval(this.clangdProgressTimer);
      this.clangdProgressTimer = null;
    }
  }

  private renderStatus(): void {
    const tab = this.activeTab();
    // clangd warm-up outranks the text-index scan when both run: it gates
    // semantic accuracy (completion / F12 / Find Usages) and takes far longer.
    const root = this.options?.getWorkspaceRoot?.() ?? null;
    const sameRoot =
      root !== null &&
      this.clangdProgressRoot !== null &&
      root.replace(/\\/g, "/").replace(/\/+$/, "") ===
        this.clangdProgressRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const clangdText = sameRoot
      ? formatClangdProgress(this.clangdProgress, Date.now(), tab?.path)
      : "";
    const progressText =
      this.gotoWaitText.length > 0
        ? this.gotoWaitText
        : clangdText.length > 0
          ? clangdText
          : this.symbolProgressText;
    const showProgress = progressText.length > 0;
    this.statusIndex.textContent = progressText;
    this.statusIndex.hidden = !showProgress;
    this.statusBar.classList.toggle(
      "is-visible",
      showProgress || (tab !== null && !this.statusSuppressedByPanel),
    );
    if (!tab) {
      this.statusPath.textContent = "";
      this.statusState.textContent = "";
      return;
    }
    this.statusPath.textContent = tab.path;
    this.statusPath.title = tab.path;
    if (this.notice) {
      this.statusState.textContent = this.notice;
      return;
    }
    let state: string;
    if (tab.status === "deleted") state = "Deleted on disk";
    else if (tab.readOnly) state = "Read-only (non-UTF-8)";
    else if (tab.dirty) state = "Unsaved changes";
    else state = "Saved";
    this.statusState.textContent = state;
  }

  /**
   * Unified bottom panel visibility: while the panel (any tab, collapsed
   * included) occupies the editor column's bottom, the file status bar
   * hides — the panel's tab strip already closes the column visually.
   * A running C++ symbol scan keeps the bar visible so its progress stays
   * on screen. Single writer: flips the flag, then renderStatus owns the class.
   */
  setStatusSuppressedByPanel(suppressed: boolean): void {
    if (this.statusSuppressedByPanel === suppressed) return;
    this.statusSuppressedByPanel = suppressed;
    this.renderStatus();
  }

  private statusSuppressedByPanel = false;

  /**
   * Live editor for the find widget (null before Monaco loads / no tab
   * attached). The controller re-checks on every open/refresh.
   */
  get activeEditor(): MonacoTypes.editor.IStandaloneCodeEditor | null {
    return this.diffController.isEnabled
      ? this.diffController.modifiedEditor
      : this.editor;
  }

  /** Monaco API for the find widget's decoration ranges. */
  get monacoApi(): MonacoApi | null {
    return this.monaco;
  }

  /** Active tab's model — find needs its line count for range clamping. */
  get activeModel(): MonacoTypes.editor.ITextModel | null {
    return this.activeTab()?.model ?? null;
  }

  /** Live buffer for a path if that file is already open (unsaved edits included). */
  getDocumentText(path: string): string | null {
    const tab = this.tabByPath(path);
    if (!tab) return null;
    return tab.model?.getValue() ?? tab.pendingContent;
  }

  /** Live buffer for the Document Outline (pending text before Monaco loads). */
  getActiveDocument(): { path: string; text: string } | null {
    const tab = this.activeTab();
    if (!tab) return null;
    const text = tab.model?.getValue() ?? tab.pendingContent;
    if (text === null) return null;
    return { path: tab.path, text };
  }

  /** Caret context for semantic queries (clangd references at Shift+F12).
   *  Position is word-anchored like F12 — selections must query the
   *  selected identifier, not the enclosing template/operator. */
  getCaretDocument(): {
    path: string;
    text: string;
    line: number;
    column: number;
    languageId: string | null;
  } | null {
    const editor = this.editor;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return null;
    const anchor = this.semanticAnchor(editor, model, position);
    return {
      path: modelUriToPath(model.uri) ?? "",
      text: model.getValue(),
      line: anchor.lineNumber,
      column: anchor.column,
      languageId: model.getLanguageId?.() ?? null,
    };
  }

  /**
   * F12 / Ctrl+click: Go to Definition at the caret.
   * C++ jumps straight to the best-ranked target (workspace symbol index +
   * engine-header fallback) via the tabbed editor — the built-in peek
   * widget only fits Alt+F12 (browse all candidates). Other languages fall
   * through to Monaco's built-in action.
   * No-op when a modal is open or the editor does not have text focus.
   */
  /**
   * Anchor the definition-search tip above the word under
   * the caret via a Monaco content widget — it tracks scrolling for free
   * and lives until ESC / the query settles.
   */
  private showClangdSearchTip(
    editor: MonacoTypes.editor.IStandaloneCodeEditor,
    model: MonacoTypes.editor.ITextModel,
    position: { lineNumber: number; column: number },
  ): void {
    this.hideClangdSearchTip();
    const monaco = this.monaco;
    if (!monaco) return;
    const node = document.createElement("div");
    node.className = "clangd-search-tip";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    // Monaco sets display:block on the widget root. Keep our flex layout
    // inside it so the spinner, label and shortcut stay on one line.
    const content = document.createElement("div");
    content.className = "clangd-search-tip-content";
    const text = document.createElement("span");
    text.className = "clangd-search-tip-label";
    text.textContent = "Searching definition…";
    const cancel = document.createElement("span");
    cancel.className = "clangd-search-tip-cancel";
    const key = document.createElement("kbd");
    key.textContent = "Esc";
    cancel.append(key, document.createTextNode("Cancel"));
    content.append(text, cancel);
    node.append(content);
    const word = model.getWordAtPosition(position);
    const anchor = {
      lineNumber: position.lineNumber,
      column: word ? word.startColumn : position.column,
    };
    const pref = monaco.editor.ContentWidgetPositionPreference;
    const widget: MonacoTypes.editor.IContentWidget = {
      getId: () => "clangd-search-tip",
      getDomNode: () => node,
      getPosition: () => ({
        position: anchor,
        preference: [pref.ABOVE, pref.BELOW],
      }),
    };
    try {
      editor.addContentWidget(widget);
    } catch {
      return; // editor torn down mid-switch — status-bar hint still covers it
    }
    this.clangdTipRemover = () => {
      try {
        editor.removeContentWidget(widget);
      } catch {
        // Editor already disposed.
      }
    };
  }

  private hideClangdSearchTip(): void {
    this.clangdTipRemover?.();
    this.clangdTipRemover = null;
  }

  /**
   * Word-anchored position for semantic queries. A backward selection (or a
   * caret parked on a word boundary) makes the raw cursor column resolve to
   * the neighbouring `<`/`>` — e.g. F12 inside `TArray<Foo>` jumping to
   * TArray. Selection start wins (first selected character), then the caret
   * when it sits inside a word, then one column left (word-end caret).
   */
  private semanticAnchor(
    editor: MonacoTypes.editor.IStandaloneCodeEditor,
    model: { getWordAtPosition(position: { lineNumber: number; column: number }): { word: string; startColumn: number; endColumn: number } | null },
    position: { lineNumber: number; column: number },
  ): { lineNumber: number; column: number } {
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      return selection.getStartPosition();
    }
    if (model.getWordAtPosition(position)) return position;
    if (position.column > 1) {
      const left = { lineNumber: position.lineNumber, column: position.column - 1 };
      if (model.getWordAtPosition(left)) return left;
    }
    return position;
  }

  /**
   * UHT RPC / BlueprintNativeEvent thunks (`Server_PlayAudio`) are defined
   * in `.gen.cpp`. The handwritten body is `Server_PlayAudio_Implementation`
   * in the class `.cpp`. When F12 would open the generated file, jump there
   * instead — and from that body, back to the header declaration.
   */
  private async preferUhtImplementation(
    model: {
      getValue(): string;
      getOffsetAt(position: { lineNumber: number; column: number }): number;
      getWordAtPosition(position: {
        lineNumber: number;
        column: number;
      }): { word: string; startColumn: number } | null;
    },
    anchor: { lineNumber: number; column: number },
    caret: { path: string; line: number },
    targets: readonly { path: string; line: number }[] | null,
    jump: { path: string; line: number } | null,
  ): Promise<{ path: string; line: number } | null> {
    const word = model.getWordAtPosition(anchor);
    if (!word) return null;
    const wanted = uhtRedirectQuery(word.word, targets, caret, jump);
    if (!wanted) return null;
    const root = this.options?.getWorkspaceRoot?.();
    if (!root) return null;
    const qualified = qualifiedContainerBefore(
      model.getValue(),
      model.getOffsetAt({ lineNumber: anchor.lineNumber, column: word.startColumn }),
    );
    const generated = (targets ?? []).find((target) => isUhtGeneratedPath(target.path));
    const generatedPath =
      jump && isUhtGeneratedPath(jump.path) ? jump.path : generated?.path ?? null;
    const load = async (fromClangd: boolean): Promise<UhtJumpCandidate[]> => {
      if (!fromClangd) {
        try {
          return (await window.jellybot?.lookupCppSymbols?.(root, wanted)) ?? [];
        } catch {
          return [];
        }
      }
      const symbols = await clangdWorkspaceSymbols(root, wanted);
      return symbols.map((symbol) => ({
        name: symbol.name,
        path: symbol.path,
        line: symbol.line,
        ...(symbol.container ? { container: symbol.container } : {}),
        isImpl: /\.(?:cpp|cc|cxx|c)$/i.test(symbol.path),
      }));
    };
    const choose = (candidates: readonly UhtJumpCandidate[]) =>
      pickUhtHandwrittenTarget({
        word: word.word,
        caret,
        container: qualified,
        generatedPath,
        candidates,
      });
    const indexed = choose(await load(false));
    if (indexed) return indexed;
    try {
      return choose(await load(true));
    } catch {
      return null;
    }
  }

  async goToDefinition(): Promise<void> {
    if (isDevModalOpen()) return;
    const editor = this.activeEditor;
    if (!editor || !editor.hasTextFocus()) return;
    const model = editor.getModel();
    const position = editor.getPosition();
    if (
      this.cppFeatures &&
      model &&
      position &&
      model.getLanguageId() === "cpp"
    ) {
      // Word-anchored query position: selections and word-boundary carets
      // must resolve the selected identifier, not the enclosing template.
      const anchor = this.semanticAnchor(editor, model, position);
      const caret = {
        path: modelUriToPath(model.uri) ?? "",
        line: anchor.lineNumber,
      };
      // The text index answers decl↔impl from SQLite. clangd's
      // textDocument/definition does not: it waits until THIS file's preamble
      // is built. The file you were just editing is warm (instant). The file
      // F12 just opened starts a new preamble, so the jump back sits on
      // "Searching definition…" for as long as that build takes. Ask both.
      // A warm clangd still wins inside the grace window; a cold one is
      // cancelled and the index jump is taken. No index hit (engine headers,
      // macros) still waits on clangd — ESC cancels.
      const root = this.options?.getWorkspaceRoot?.();
      const cancel = new AbortController();
      let userCancelled = false;
      const onEsc = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        userCancelled = true;
        cancel.abort();
      };
      if (root) {
        // Capture-only: ESC aborts the search but must not swallow the key.
        window.addEventListener("keydown", onEsc, { capture: true });
      }
      const clangdPromise = root
        ? clangdGotoDefinition(root, model, anchor, cancel.signal)
        : Promise.resolve(null);
      try {
        const targets = await this.cppFeatures.gotoDefinition(model, anchor);
        if (userCancelled) return;
        const indexedJump = pickJumpTarget(targets, caret);
        const indexedHandwritten = await this.preferUhtImplementation(
          model,
          anchor,
          caret,
          targets,
          indexedJump,
        );
        if (userCancelled) return;
        const indexed = indexedHandwritten ?? indexedJump;
        let semantic: CppGotoTarget[] | null = null;
        if (root) {
          if (indexed) {
            semantic = await raceWithGrace(clangdPromise, DEFINITION_TEXT_GRACE_MS);
          } else {
            this.showClangdSearchTip(editor, model, anchor);
            this.gotoWaitText = "Searching definition… · Esc to cancel";
            this.renderStatus();
            semantic = await Promise.race([
              clangdPromise,
              new Promise<null>((resolve) =>
                cancel.signal.addEventListener("abort", () => resolve(null), { once: true }),
              ),
            ]);
          }
        }
        if (userCancelled) return;
        const semanticJump = pickJumpTarget(semantic, caret);
        const semanticHandwritten =
          semantic && semantic.length > 0
            ? await this.preferUhtImplementation(
                model,
                anchor,
                caret,
                semantic,
                semanticJump,
              )
            : null;
        if (userCancelled) return;
        const landing = semanticHandwritten ?? semanticJump ?? indexed;
        if (!semanticHandwritten && !semanticJump) cancel.abort();
        if (landing) {
          await this.revealFileLine(landing.path, landing.line);
          return;
        }
        if ((semantic?.length ?? 0) > 0 || (targets?.length ?? 0) > 0) {
          // Every answer is the caret itself (inline definition, no separate
          // declaration) — say so instead of opening Quick Open.
          const word = model.getWordAtPosition(anchor)?.word ?? "symbol";
          this.setNotice(`No other declaration or implementation of ${word}`, 2500);
          return;
        }
      } finally {
        if (root) {
          window.removeEventListener("keydown", onEsc, { capture: true } as EventListenerOptions);
        }
        this.hideClangdSearchTip();
        this.gotoWaitText = "";
        this.renderStatus();
      }
    }
    // Nothing resolved — search the workspace for the identifier instead of
    // showing Monaco's native "No definition found" widget. The Quick Open
    // index covers files and symbols (engine sources via `~engine`).
    const word =
      model && position
        ? model.getWordAtPosition(
            this.semanticAnchor(this.activeEditor!, model, position),
          )?.word.trim() ?? model.getWordAtPosition(position)?.word.trim()
        : undefined;
    if (word && this.options?.onOpenSymbolSearch) {
      this.options.onOpenSymbolSearch(word);
      return;
    }
    // No Monaco native revealDefinition for any language: its peek widget /
    // multi-definition picker is unstyled for Dev Mode. Our ranked jump +
    // Quick Open own the whole F12 flow.
  }

  async resolveCppUsageTarget(): Promise<CppUsageTarget | null> {
    const model = this.editor?.getModel();
    const position = this.editor?.getPosition();
    const editor = this.editor;
    if (!model || !position || !editor || !this.cppFeatures) return null;
    if (model.getLanguageId() !== "cpp") return null;
    // Same word-anchoring as F12: selections must query the selected word.
    const anchor = this.semanticAnchor(editor, model, position);
    return await this.cppFeatures.resolveUsageTarget(model, anchor);
  }

  /**
   * Quick Open jump: open (or focus) a tab and reveal a line — centered,
   * cursor placed, and a short accent wash so the landing spot reads.
   */
  async revealFileLine(
    path: string,
    line?: number,
    column?: number,
  ): Promise<void> {
    await this.openFile(path);
    const editor = this.activeEditor;
    if (!editor || !line || line < 1) return;
    const tab = this.tabByPath(path);
    if (!tab || !tab.model) return;
    const clamped = Math.min(line, tab.model.getLineCount());
    const maxCol = tab.model.getLineMaxColumn(clamped);
    const col = column && column > 0 ? Math.min(column, maxCol) : 1;
    editor.revealLineInCenter(clamped);
    editor.setPosition({ lineNumber: clamped, column: col });
    editor.focus();
    const deco = editor.createDecorationsCollection([
      {
        range: new this.monaco!.Range(clamped, 1, clamped, 1),
        options: {
          isWholeLine: true,
          className: "quickopen-jump-flash",
        },
      },
    ]);
    window.setTimeout(() => deco.clear(), 1600);
  }
}
