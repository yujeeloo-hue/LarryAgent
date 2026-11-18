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
import { BreakpointGutterController } from "./BreakpointGutterController.js";
import { CompactLanguagePopoverView } from "./CompactLanguagePopoverView.js";
import type { DebugHoverValue } from "./DebugController.js";
import { AGENT_OPEN_MAX_TABS, pickAgentEvictionVictim } from "./editorTabs.js";
import {
  normalizeFlashRanges,
  type AgentFlashRange,
} from "./agentFlash.js";

const FLASH_CLEAR_MS = 1800;
import { registerCppLanguageFeatures } from "./cppLanguageFeatures.js";
import type { CppGotoTarget } from "./cppLanguageFeatures.js";
import {
  clangdAvailable,
  clangdGotoDefinition,
  clangdSymbolHover,
  clangdWorkspaceSymbols,
  registerClangdProviders,
  type BareSuggestEditor,
  type ClangdMonacoLike,
} from "./clangdFeatures.js";
import { modelUriToPath, qualifiedContainerBefore } from "./cppLanguageFeatures.js";
import {
  resolveCppCounterpart,
} from "./cppCounterpart.js";
import { UnrealNetCodegenController } from "./unrealNetCodegenController.js";
import { addIncludeForSymbolAtCaret } from "./cppIncludeController.js";
import type { NetCodegenEdit } from "./unrealNetCodegen.js";
import type { CppUsageTarget } from "./cppFindUsages.js";
import { formatCppSymbolIndexProgress } from "./cppSymbolProgress.js";
import { IndexingSpeedControl } from "./IndexingSpeedControl.js";
import {
  applyClangdProgress,
  clangdProgressNeedsTick,
  createClangdProgressState,
  formatClangdProgressParts,
  type ClangdProgressPart,
} from "./clangdProgress.js";
import { StatusCarousel } from "./statusCarousel.js";
import { languageForPath } from "./languages.js";
import { devModeEditorScrollbar } from "./editorStyle.js";
import { createLanguageIcon } from "../ui/languageIcons.js";
import { MessageSquareQuote } from "lucide";
import {
  definitionTargetFromOpener,
  disableCtrlClickGoto,
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
  createLucideIcon,
  X,
} from "../ui/originalIcons.js";
import { attachInlineCompletion } from "./InlineCompletionController.js";
import { createDevModeIcon, type DevModeIconName } from "./launchIcon.js";
import { setButtonLoading, withButtonLoading } from "./buttonLoading.js";
import { debugButtonTitle, type DebugRecipe } from "../../../debug/debugCopy.js";

type EditorTab = {
  path: string;
  label: string;
  languageId: string;
  model: MonacoTypes.editor.ITextModel | null;
  pendingContent: string | null;
  baseContent: string;
  savedContent: string;
  dirty: boolean;
  readOnly: boolean;
  hadBom: boolean;
  status: "ok" | "deleted";
  viewState: MonacoTypes.editor.ICodeEditorViewState | null;
  vcsDiff: VcsFileDiff | null;
  annotated: boolean;
  blame: BlameEntry[] | null;
  blameKind: "git" | "svn" | null;
};

function normalizePath(p: string): string {
  const path = p.replace(/\\/g, "/");
  return !path || /^(?:[A-Za-z]:|\/)/.test(path) ? path : `/${path}`;
}

const RELOAD_COALESCE_MS = 120;
const CLANGD_SYNC_DEBOUNCE_MS = 400;

const MINIMAP_KEY = "jellybot.devModeMinimap";
const INLINE_COMPLETION_KEY = "jellybot.devModeInlineCompletion";
const BLAME_HOVER_MAX_LINES = 5000;
const PLAIN_LINE_NUMBER_MIN_CHARS = 3;
const PLAIN_LINE_DECORATIONS_WIDTH = 5;
const BLAME_LINE_DECORATIONS_WIDTH = 9;

const TABS_KEY_PREFIX = "jellybot.devmode.tabs.";
const TAB_SAVE_DEBOUNCE_MS = 500;
const RESTORE_MAX_TABS = 12;

function readMinimapEnabled(): boolean {
  try {
    return localStorage.getItem(MINIMAP_KEY) === "1";
  } catch {
    return false;
  }
}

function readInlineCompletionEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(INLINE_COMPLETION_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInlineCompletionEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(INLINE_COMPLETION_KEY, enabled ? "1" : "0");
  } catch {
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
    return null;
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
  }
}

export type TabActivationSource = "tab" | "open" | "close";

export type EditorAreaOptions = {
  onActiveTabChanged?: (path: string, source: TabActivationSource) => void;
  onReferenceFile?: (path: string, name: string) => void;
  onRevealInTree?: (path: string) => void;
  getWorkspaceRoot?: () => string | null;
  getSessionId?: () => string | null;
  onDiffModeChanged?: (enabled: boolean) => void;
  onBreakpointToggle?: (path: string, line: number) => void;
  onBreakpointCondition?: (path: string, line: number) => void;
  onDebugHover?: (expression: string) => Promise<DebugHoverValue | null>;
  onDebugVariables?: (
    variablesReference: number,
  ) => Promise<DebugVariable[]>;
  onDocumentChanged?: () => void;
  onCursorLineChanged?: (line: number) => void;
  onOpenSymbolSearch?: (query: string) => void;
  onFindUsages?: () => void;
  onEscape?: () => void;
  queryFileIndex?: (base: string) =>
    | readonly { path: string; rel: string }[]
    | null;
};

import { UnrealLaunchControls } from "./UnrealLaunchControls.js";

export class EditorAreaController {
  private readonly unrealLaunch: UnrealLaunchControls;
  onDebugStop: (() => void) | null = null;
  onTaskLaunch: ((task: string) => void) | null = null;
  private readonly root: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly tabScroller: HTMLElement;
  private readonly tabPrev: HTMLButtonElement;
  private readonly tabNext: HTMLButtonElement;
  private tabResizeObserver: ResizeObserver | null = null;
  private readonly editorHost: HTMLElement;
  private readonly editorCanvas: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly emptyTitle: HTMLElement;
  private readonly emptyHint: HTMLElement;
  private readonly statusBar: HTMLElement;
  private readonly statusNotice: HTMLElement;
  private readonly statusIndex: HTMLElement;
  private readonly statusCarousel: StatusCarousel;
  private readonly indexingSpeedControl: IndexingSpeedControl;

  private tabs: EditorTab[] = [];
  private activePath: string | null = null;
  private attachedPath: string | null = null;
  private monaco: MonacoApi | null = null;
  private monacoPromise: Promise<void> | null = null;
  private cppFeatures: ReturnType<typeof registerCppLanguageFeatures> | null =
    null;
  private clangdProviders: ReturnType<typeof registerClangdProviders> | null = null;
  private inlineCompletion: { dispose(): void } | null = null;
  private unrealNetCodegen: UnrealNetCodegenController | null = null;
  private editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null;
  private editorOpener: { dispose(): void } | null = null;
  private unsubGoToDefinition: (() => void) | null = null;
  private unsubFindUsages: (() => void) | null = null;
  private unsubSymbolProgress: (() => void) | null = null;
  private symbolProgressText = "";
  private readonly clangdProgress = createClangdProgressState();
  private clangdProgressTimer: number | null = null;
  private clangdProgressRoot: string | null = null;
  private gotoWaitText = "";
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
  private flashCollection: MonacoTypes.editor.IEditorDecorationsCollection | null =
    null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private debugHoverView: DebugHoverView | null = null;
  private breakpointGutter: BreakpointGutterController | null = null;
  private languagePopoverView: CompactLanguagePopoverView | null = null;
  private debugBreakpoints = new Map<
    string,
    Map<number, BreakpointValue>
  >();
  private debugExecutionLocation: { path: string; line: number } | null = null;
  private debugFrameLocation: { path: string; line: number } | null = null;
  private debugEnabled = false;
  private readonly blameHover = new BlameHoverController();
  private readonly launchPill: HTMLElement;
  private readonly minimapButton: HTMLButtonElement;
  private readonly diffButton: HTMLButtonElement;
  private readonly annotateButton: HTMLButtonElement;
  private readonly launchRow: HTMLElement;
  private readonly buildButton: HTMLButtonElement;
  private readonly deployButton: HTMLButtonElement;
  private readonly debugLaunchButton: HTMLButtonElement;
  private readonly configButton: HTMLButtonElement;

  onBuildClick: (() => void) | null = null;
  onDeployClick: (() => void) | null = null;
  onDebugClick: ((buildId?: string) => void) | null = null;
  onConfigClick: (() => void) | null = null;
  private readonly diffController: EditorDiffController;
  private diffTogglePending = false;
  private minimapEnabled = readMinimapEnabled();
  private inlineCompletionEnabled = readInlineCompletionEnabled();
  private inlineCompletionKey: MonacoTypes.editor.IContextKey<boolean> | null = null;
  private inlineCompletionMenu: { dispose(): void } | null = null;
  private minimapAnim: Animation | null = null;
  private closingPath: string | null = null;
  private readonly pendingCloses: string[] = [];
  private savedTabsRoot: string | null = null;
  private saveTabsTimer: number | null = null;
  private restoringTabs = false;
  private restoreGeneration = 0;
  private destroyed = false;
  private closeAnimTimer: number | null = null;
  private suppressEditorFocus = false;
  private collaborativeView: { tab: HTMLElement; save: () => boolean; exit: () => void } | null = null;
  private readonly keydown = (event: KeyboardEvent): void => {
    if (isDevModalOpen()) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      if (this.collaborativeView?.save()) return;
      void this.saveActive();
    }
  };
  private readonly flushTabsOnUnload = (): void => this.flushTabMemory();

  constructor(private readonly options?: EditorAreaOptions) {
    this.root = document.createElement("div");
    this.root.className = "devmode-editor-root";

    this.tabBar = document.createElement("div");
    this.tabBar.className = "devmode-tabs";
    this.tabScroller = document.createElement("div");
    this.tabScroller.className = "devmode-tabs-scroll";

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
    this.editorCanvas = document.createElement("div");
    this.editorCanvas.className = "devmode-editor-canvas";
    this.editorHost.append(this.editorCanvas);
    const executionArrow = createLucideIcon(ArrowRight, {
      size: 15,
      strokeWidth: 2.5,
    });
    executionArrow.setAttribute("stroke", "#d6a94a");
    this.editorHost.style.setProperty(
      "--devmode-debug-arrow",
      `url("data:image/svg+xml,${encodeURIComponent(executionArrow.outerHTML)}")`,
    );
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
      onLoadingChange: (loading) => setButtonLoading(this.diffButton, loading),
      onModeChanged: (enabled) => {
        this.editorHost.classList.toggle("is-diff-hidden", enabled);
        this.updateLocalEditorButtons();
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
    this.statusNotice = document.createElement("span");
    this.statusNotice.className = "devmode-status-notice";
    this.statusIndex = document.createElement("span");
    this.statusIndex.className = "devmode-status-index";
    this.statusIndex.hidden = true;
    this.statusCarousel = new StatusCarousel(this.statusIndex);
    this.indexingSpeedControl = new IndexingSpeedControl({
      onChanged: (root, speed) => {
        if (root !== this.options?.getWorkspaceRoot?.()) return;
        this.clangdProgress.indexingSpeed = speed;
        this.renderStatus();
      },
      onError: message => this.setNotice(message, 6000),
    });
    this.statusBar.append(this.statusNotice, this.statusIndex, this.indexingSpeedControl.button);

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
    this.annotateButton = mkFab("Annotate (blame)", "blame");
    this.annotateButton.disabled = true;
    this.annotateButton.addEventListener("click", () => {
      const tab = this.activeTab();
      if (tab) void this.toggleAnnotate(tab.path);
    });
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
    this.buildButton = mkLaunch("Build", "build");
    this.buildButton.addEventListener("click", () => this.unrealLaunch.active ? void this.unrealLaunch.buildSelected() : this.onBuildClick?.());
    this.debugLaunchButton = mkLaunch(debugButtonTitle(null), "run");
    this.debugLaunchButton.disabled = true;
    this.debugLaunchButton.addEventListener("click", () =>
      this.unrealLaunch.active ? this.unrealLaunch.debugClick() : this.onDebugClick?.(),
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
    this.unrealLaunch = new UnrealLaunchControls(this.buildButton, this.debugLaunchButton, {
      revealTask: task => this.onTaskLaunch?.(task),
      debug: id => this.onDebugClick?.(id),
      stopDebug: () => this.onDebugStop?.(),
    });

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

  appendFab(btn: HTMLButtonElement): void {
    this.launchPill.append(btn);
  }

  installCollaborativeView(host: HTMLElement, tab: HTMLElement, handlers: { save: () => boolean; exit: () => void }): void {
    this.collaborativeView = { tab, ...handlers };
    this.root.insertBefore(host, this.statusBar);
    this.tabScroller.append(tab);
  }

  collaborativeLocalDocument(path: string): { model: MonacoTypes.editor.ITextModel; readOnly: boolean; savedContent: string } | null {
    const tab = this.tabByPath(path);
    return tab?.model ? { model: tab.model, readOnly: tab.readOnly, savedContent: tab.savedContent } : null;
  }

  acceptCollaborativeLocalSave(path: string, content: string): void {
    const tab = this.tabByPath(path);
    if (!tab?.model) return;
    tab.savedContent = content;
    tab.baseContent = content;
    tab.status = "ok";
    tab.dirty = tab.model.getValue() !== content;
    this.renderTabs();
    this.renderStatus();
    this.scheduleVcsDiff(path, 600);
    this.refreshAnnotate(path);
  }

  showCollaborativeView(visible: boolean): void {
    const changed = this.root.classList.contains("is-collaborative-view") !== visible;
    if (visible) this.diffController.disable();
    this.root.classList.toggle("is-collaborative-view", visible);
    this.updateLocalEditorButtons();
    if (changed && !visible) this.editor?.layout();
  }

  private updateLocalEditorButtons(): void {
    const dualView =
      this.diffController.isEnabled ||
      this.root.classList.contains("is-collaborative-view");
    this.minimapButton.hidden = dualView;
    this.annotateButton.hidden = dualView;
  }

  async prepareCollaborativeEditor(): Promise<MonacoApi> {
    await this.ensureMonaco();
    if (!this.monaco) throw new Error("Editor unavailable");
    return this.monaco;
  }

  destroy(): void {
    this.destroyed = true;
    this.restoreGeneration++;
    if (this.closeAnimTimer !== null) {
      window.clearTimeout(this.closeAnimTimer);
      this.closeAnimTimer = null;
    }
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
    this.statusCarousel.destroy();
    this.indexingSpeedControl.destroy();
    if (this.clangdProgressTimer !== null) {
      window.clearInterval(this.clangdProgressTimer);
      this.clangdProgressTimer = null;
    }
    this.unrealLaunch.dispose();
    this.cppFeatures?.dispose();
    this.cppFeatures = null;
    this.clangdProviders?.dispose();
    this.clangdProviders = null;
    this.inlineCompletion?.dispose();
    this.inlineCompletion = null;
    this.inlineCompletionMenu?.dispose();
    this.inlineCompletionMenu = null;
    this.inlineCompletionKey = null;
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
    for (const timer of this.clangdSyncTimers.values()) {
      clearTimeout(timer);
    }
    this.clangdSyncTimers.clear();
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
    this.breakpointGutter?.destroy();
    this.breakpointGutter = null;
    this.debugExecutionCollection?.clear();
    this.debugExecutionCollection = null;
    this.debugFrameCollection?.clear();
    this.debugFrameCollection = null;
    this.debugHoverView?.destroy();
    this.debugHoverView = null;
    this.languagePopoverView?.destroy();
    this.languagePopoverView = null;
    this.blameHover.destroy();
    this.diffController.destroy();
    for (const tab of this.tabs) {
      this.closeClangdDocument(tab.path, this.savedTabsRoot);
      tab.model?.dispose();
    }
    this.tabs = [];
    this.pendingCloses.length = 0;
    this.minimapAnim?.cancel();
    this.minimapAnim = null;
    this.editor?.dispose();
    this.editor = null;
    this.statusBar.remove();
    this.root.remove();
  }

  private dismissSuggest(editor: MonacoTypes.editor.IStandaloneCodeEditor | null): boolean {
    if (!editor) return false;
    return (
      this.clangdProviders?.dismissSuggest(
        editor as unknown as BareSuggestEditor,
      ) ?? false
    );
  }

  async switchWorkspaceTabs(nextRoot: string | null): Promise<void> {
    if (this.destroyed) return;
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
    const cleared = await this.closeAllTabsOnSwitch(prevRoot);
    if (this.destroyed) return;
    if (!cleared) {
      this.savedTabsRoot = prevRoot;
      return;
    }
    this.renderStatus();
    if (!nextRoot) return;
    const saved = readSavedTabs(nextRoot);
    if (!saved || saved.files.length === 0) return;
    await this.restoreTabs(saved);
  }

  private async restoreTabs(saved: SavedTabState): Promise<void> {
    this.restoringTabs = true;
    const generation = this.restoreGeneration;
    try {
      for (const path of saved.files) {
        if (generation !== this.restoreGeneration) return;
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
        const current = this.activeTab();
        if (current?.model) {
          this.warmClangdDocument(current.path, current.model.getValue());
        }
        this.scheduleTabSave();
      }
    }
  }

  private async closeAllTabsOnSwitch(outgoingRoot?: string | null): Promise<boolean> {
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
    for (const tab of [...this.tabs]) this.disposeTab(tab.path, outgoingRoot);
    return true;
  }

  private scheduleTabSave(): void {
    if (!this.savedTabsRoot || this.restoringTabs) return;
    if (this.saveTabsTimer !== null) window.clearTimeout(this.saveTabsTimer);
    this.saveTabsTimer = window.setTimeout(() => {
      this.saveTabsTimer = null;
      this.flushTabMemory();
    }, TAB_SAVE_DEBOUNCE_MS);
  }

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


  async openFile(
    path: string,
    options?: { revealInTree?: boolean },
  ): Promise<void> {
    if (this.destroyed) return;
    const normalized = normalizePath(path);
    const existing = this.tabByPath(normalized);
    if (existing) {
      this.activateTab(normalized, "open");
      if (options?.revealInTree) this.options?.onRevealInTree?.(existing.path);
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
    if (this.destroyed) return;

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
    this.activePath = normalized;
    this.options?.onActiveTabChanged?.(normalized, "open");
    if (options?.revealInTree) this.options?.onRevealInTree?.(normalized);
    this.renderTabs();
    this.playTabEnter(normalized);
    this.setNotice(null);
    this.scheduleTabSave();

    await this.ensureMonaco();
    if (this.destroyed) return;
    this.materializePendingTabs();
    this.attachActive();
    this.scheduleVcsDiff(normalized, 300);
  }

  async openAgentFile(path: string): Promise<void> {
    if (this.destroyed) return;
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
        this.activateTab(normalized, "open");
        await this.reloadFromDisk(normalized);
      } else {
        await this.openFile(path);
      }
    } finally {
      this.suppressEditorFocus = false;
    }
  }

  private async toggleCounterpartTab(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const tab = this.tabByPath(normalized);
    if (!tab) return;
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
      if (open && open.path !== normalized) {
        this.activateTab(open.path);
        return;
      }
      await this.replaceTabWith(normalized, normalizePath(target));
    } catch (err) {
      console.warn("[CounterpartDbg] toggle threw:", err, trace.join(" | "));
      this.setNotice(`[CounterpartDbg] threw: ${String(err)}`, 8000);
    }
  }

  private netCodegenController(): UnrealNetCodegenController {
    if (!this.unrealNetCodegen) {
      this.unrealNetCodegen = new UnrealNetCodegenController({
        getActiveDocument: () => {
          const doc = this.getActiveDocument();
          if (!doc) return null;
          const caret = this.getCaretDocument();
          return { path: doc.path, text: doc.text, line: caret?.line ?? 1 };
        },
        resolveCounterpart: (path) => this.resolveCounterpartPath(path),
        ensureOpen: async (path) => {
          await this.openFile(path);
        },
        getDocumentText: (path) => this.getDocumentText(path),
        applyEdits: (path, edits) => this.applyTextEdits(path, edits),
        activate: (path) => this.activateTab(normalizePath(path), "open"),
        notice: (message, ttlMs) => this.setNotice(message, ttlMs),
        workspaceRoot: () => this.options?.getWorkspaceRoot?.() ?? null,
        readTextFile: async (path) => {
          const bridge = window.jellybot;
          if (!bridge?.readTextFile) return null;
          try {
            const result = await bridge.readTextFile(path);
            return result.ok ? result.content : null;
          } catch {
            return null;
          }
        },
      });
    }
    return this.unrealNetCodegen;
  }

  private addIncludeAtCaret(): Promise<boolean> {
    return addIncludeForSymbolAtCaret({
      workspaceRoot: () => this.options?.getWorkspaceRoot?.() ?? null,
      activeDocument: () => {
        const doc = this.getActiveDocument();
        return doc ? { path: doc.path, text: doc.text } : null;
      },
      symbolAtCaret: () => {
        const editor = this.editor;
        const model = editor?.getModel();
        const position = editor?.getPosition();
        if (!model || !position) return null;
        return model.getWordAtPosition(position)?.word ?? null;
      },
      lookupSymbols: async (root, word) => {
        try {
          return (await window.jellybot?.lookupCppSymbols?.(root, word)) ?? [];
        } catch {
          return [];
        }
      },
      lookupIndexSymbols: async (root, word) =>
        (await clangdWorkspaceSymbols(root, word)).map((symbol) => ({
          name: symbol.name,
          kind: symbol.symbolKind,
          path: symbol.path,
          line: symbol.line,
        })),
      includeDirs: async (root, file) => {
        try {
          const result = await window.jellybot?.clangdIncludeDirs?.(root, file);
          return result && result.ok ? result.dirs : [];
        } catch {
          return [];
        }
      },
      applyInsertion: (path, insertion) =>
        this.applyTextEdits(path, [
          {
            startLine: insertion.line,
            startColumn: 1,
            endLine: insertion.line,
            endColumn: 1,
            text: insertion.text,
          },
        ]),
      notice: (message, ttlMs) => this.setNotice(message, ttlMs),
      log: (entry) => {
        void window.jellybot?.clangdLogInclude?.(entry).catch(() => {});
      },
    });
  }

  private resolveCounterpartPath(path: string): Promise<string | null> {
    return resolveCppCounterpart(
      normalizePath(path),
      (root, query, options) =>
        window.jellybot?.searchDevModeFiles?.(root, query, options),
      (paths) => window.jellybot?.filterExistingFiles?.(paths),
      (base) => this.options?.queryFileIndex?.(base) ?? null,
    );
  }

  private applyTextEdits(
    path: string,
    edits: readonly NetCodegenEdit[],
  ): boolean {
    const tab = this.tabByPath(normalizePath(path));
    const monaco = this.monaco;
    if (!tab?.model || !monaco || edits.length === 0) return false;
    const operations = edits.map((edit) => ({
      range: new monaco.Range(
        edit.startLine,
        edit.startColumn,
        edit.endLine,
        edit.endColumn,
      ),
      text: edit.text,
    }));
    tab.model.pushEditOperations([], operations, () => null);
    return true;
  }

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
    if (from === -1) return;
    if (from > index) {
      const moved = this.tabs.splice(from, 1)[0];
      if (moved) {
        this.tabs.splice(index, 0, moved);
        this.renderTabs();
      }
    }
    this.disposeTab(oldPath);
  }

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


  private motionReduced(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  pulseTab(path: string): void {
    if (this.motionReduced()) return;
    const el = this.tabElFor(normalizePath(path));
    if (!el) return;
    el.classList.remove("is-written");
    void el.offsetWidth;
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


  private ensureMonaco(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.monaco) return Promise.resolve();
    if (!this.monacoPromise) {
      this.emptyTitle.textContent = "Loading editor…";
      this.emptyHint.textContent = "";
      this.monacoPromise = loadMonaco()
        .then((monaco) => {
          if (this.destroyed) return;
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
    if (this.destroyed || !this.monaco || this.editor) return;
    const monaco = this.monaco;
    this.diffController.setMonaco(monaco);
    this.editorHost.style.setProperty("--devmode-editor-bg", DEV_MODE_EDITOR_BG);
    this.editor = monaco.editor.create(this.editorCanvas, {
      scrollbar: { ...devModeEditorScrollbar },
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
      suggestOnTriggerCharacters: true,
      quickSuggestions: { other: "on", comments: "off", strings: "off" },
      quickSuggestionsDelay: 10,
      suggestLineHeight: 28,
      suggestFontSize: 12.5,
      suggest: {
        snippetsPreventQuickSuggestions: false,
        localityBonus: true,
        showStatusBar: false,
      },
      parameterHints: { enabled: true, cycle: true },
      hover: { enabled: "on", sticky: true },
      autoClosingBrackets: "languageDefined",
      autoClosingQuotes: "languageDefined",
      autoClosingOvertype: "always",
      autoClosingDelete: "always",
      autoSurround: "languageDefined",
      autoIndent: "full",
      inlineSuggest: {
        enabled: this.inlineCompletionEnabled,
        showToolbar: "onHover",
        suppressInSnippetMode: true,
        minShowDelay: 0,
      },
    });
    disableCtrlClickGoto(this.editor);
    this.editor.addCommand(monaco.KeyCode.Escape, () => {
      if (this.dismissSuggest(this.editor)) return;
      this.editor?.trigger("keyboard", "editor.action.inlineSuggest.hide", {});
      this.options?.onEscape?.();
      const controller = (
        this.editor as unknown as {
          getContribution?: (id: string) => unknown;
        }
      ).getContribution?.("editor.contrib.findController") as {
        closeFindWidget?: () => void;
      } | null;
      controller?.closeFindWidget?.();
    });
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space,
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
        void this.revealFileLine(target.path, target.line, target.column, {
          revealInTree: true,
        });
        return true;
      },
    });
    this.cppFeatures?.dispose();
    this.languagePopoverView = new CompactLanguagePopoverView(this.editorHost, this.editor);
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
        getSemanticHover: (model, position) => {
          const root = this.options?.getWorkspaceRoot?.();
          return root ? clangdSymbolHover(root, model, position) : Promise.resolve(null);
        },
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
    this.clangdProviders?.dispose();
    this.inlineCompletion?.dispose();
    this.inlineCompletion = attachInlineCompletion(monaco, this.editor, {
      isEnabled: () => this.inlineCompletionEnabled,
      isDiffOpen: () => this.diffController.isEnabled,
      isReadOnly: () => this.activeTab()?.readOnly === true,
      sessionId: () => this.options?.getSessionId?.() ?? null,
      workspacePath: () => this.options?.getWorkspaceRoot?.() ?? null,
    });
    this.clangdProviders = registerClangdProviders(
      {
        languages: monaco.languages,
        editor: monaco.editor as NonNullable<ClangdMonacoLike["editor"]>,
      },
      {
        getWorkspaceRoot: () => this.options?.getWorkspaceRoot?.() ?? null,
        registerHover: false,
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
    this.breakpointGutter = new BreakpointGutterController(
      monaco,
      this.editor,
      (line) => {
        const tab = this.activeTab();
        if (!this.debugEnabled || !tab?.model) return false;
        const path = normalizePath(tab.path);
        if (this.debugBreakpoints.get(path)?.has(line)) return false;
        return ![this.debugExecutionLocation, this.debugFrameLocation].some(
          (location) => location?.line === line &&
            location.path.toLowerCase() === path.toLowerCase(),
        );
      },
    );
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
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
      () => undefined,
    );
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
    this.editor.addCommand(monaco.KeyCode.F12, () => this.goToDefinition());
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
    this.editor.addAction({
      id: "jellybot.unreal.generateReplication",
      label: "Unreal: Generate Replication Code",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.7,
      run: () => void this.netCodegenController().run(),
    });
    this.editor.addAction({
      id: "jellybot.cpp.addInclude",
      label: "Add Include for Symbol",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyI],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.8,
      run: () => void this.addIncludeAtCaret(),
    });
    this.registerInlineCompletionMenu();
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
        uri = undefined;
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
        this.scheduleClangdSync(tab.path, model);
      });
    }
  }

  private readonly clangdSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleClangdSync(path: string, model: MonacoTypes.editor.ITextModel): void {
    const pending = this.clangdSyncTimers.get(path);
    if (pending) clearTimeout(pending);
    this.clangdSyncTimers.set(
      path,
      setTimeout(() => {
        this.clangdSyncTimers.delete(path);
        if (model.isDisposed() || this.tabByPath(path)?.model !== model) return;
        const root = this.options?.getWorkspaceRoot?.();
        if (!root) return;
        void clangdAvailable(root).then((ok) => {
          if (ok && !model.isDisposed()) this.warmClangdDocument(path, model.getValue());
        });
      }, CLANGD_SYNC_DEBOUNCE_MS),
    );
  }

  private warmClangdDocument(path: string, text: string): void {
    if (!/\.(?:c|h|cpp|hpp|hxx|cc|cxx|inl)$/i.test(path)) return;
    const root = this.options?.getWorkspaceRoot?.();
    if (!root) return;
    const bridge = window.jellybot;
    if (!bridge?.clangdDocChanged) return;
    void bridge.clangdDocChanged(root, path, text).catch(() => {});
  }

  private closeClangdDocument(path: string, rootOverride?: string | null): void {
    const pending = this.clangdSyncTimers.get(path);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.clangdSyncTimers.delete(path);
    }
    if (!/\.(?:c|h|cpp|hpp|hxx|cc|cxx|inl)$/i.test(path)) return;
    const root = rootOverride ?? this.savedTabsRoot ?? this.options?.getWorkspaceRoot?.();
    if (!root) return;
    const bridge = window.jellybot;
    if (!bridge?.clangdDocClosed) return;
    void bridge.clangdDocClosed(root, path).catch(() => {});
  }

  private attachActive(): void {
    const tab = this.activeTab();
    if (!this.editor) return;
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
    if (!this.restoringTabs) {
      this.warmClangdDocument(tab.path, tab.model.getValue());
    }
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


  setBuildState(running: boolean, failed: boolean): void {
    this.unrealLaunch.setBuildState(running);
    this.buildButton.classList.toggle("is-running", running);
    this.buildButton.classList.toggle("is-failed", failed);
  }

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
    if (this.unrealLaunch.active) return;
    this.buildButton.title = title;
  }

  setDebugRecipe(kind: DebugRecipe | null): void {
    if (this.unrealLaunch.active) return;
    this.debugLaunchButton.title = debugButtonTitle(kind);
    this.debugLaunchButton.disabled = kind === null;
  }

  setConfigVisible(visible: boolean): void {
    this.configButton.hidden = !visible;
  }

  setUnrealWorkspace(path: string | null): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return this.unrealLaunch.setWorkspace(path);
  }
  getUnrealSourceRoots(): string[] { return this.unrealLaunch.sourceRoots; }
  setUnrealDebugState(snapshot: { status: string; workspacePath: string }): void { this.unrealLaunch.setDebugState(snapshot); }
  refreshUnrealFiles(events: Array<{ path: string }>): void { this.unrealLaunch.refreshForFiles(events); }

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
    this.breakpointGutter?.refresh();
  }

  setDebugFrameLocation(path: string, line: number): void;
  setDebugFrameLocation(path: null, line?: undefined): void;
  setDebugFrameLocation(path: string | null, line?: number): void {
    this.debugFrameLocation =
      path && line && line > 0
        ? { path: normalizePath(path), line }
        : null;
    this.applyDebugFrameDecoration();
    this.breakpointGutter?.refresh();
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
    this.breakpointGutter?.refresh();
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
                ? `Break when \`${text.replace(/`/g, "'")}\`.\n\nClick to remove breakpoint.\n\nRight-click or Alt-click to edit the condition.`
                : `Breakpoint at line ${line}.\n\nClick to remove breakpoint.\n\nRight-click or Alt-click to set a condition.`
              : `Disabled breakpoint at line ${line}.\n\nClick to remove breakpoint.\n\nRight-click or Alt-click to edit the condition.`,
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
    if (!target) return true;
    this.closeTab(target.path);
    return true;
  }

  private tabSuccessor(path: string): EditorTab | null {
    const index = this.tabs.findIndex((tab) => tab.path === path);
    if (index === -1) return null;
    return this.tabs[index + 1] ?? this.tabs[index - 1] ?? null;
  }

  private isClosing(path: string): boolean {
    return path === this.closingPath || this.pendingCloses.includes(path);
  }

  private requestClose(path: string): boolean {
    if (path === this.closingPath) return true;
    if (this.closingPath !== null) {
      if (!this.pendingCloses.includes(path)) this.pendingCloses.push(path);
      return true;
    }
    this.disposeTabAnimated(path);
    return true;
  }

  private disposeTabAnimated(path: string): void {
    const el = this.tabElFor(path);
    if (!el || this.motionReduced()) {
      this.disposeTab(path);
      this.drainCloseQueue();
      return;
    }
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
    void el.offsetWidth;
    el.style.width = "0px";
    this.closingPath = path;
    if (this.closeAnimTimer !== null) window.clearTimeout(this.closeAnimTimer);
    this.closeAnimTimer = window.setTimeout(() => {
      this.closeAnimTimer = null;
      if (this.destroyed) return;
      this.disposeTab(path);
      this.closingPath = null;
      this.drainCloseQueue();
    }, 170);
  }

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
    this.pendingCloses.length = 0;
    if (keep !== null) this.activateTab(keep);
  }

  private disposeTab(path: string, rootOverride?: string | null): void {
    const index = this.tabs.findIndex((tab) => tab.path === path);
    if (index === -1) return;
    const tab = this.tabs[index]!;
    this.closeClangdDocument(path, rootOverride);
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
    this.scheduleVcsDiff(tab.path, 600);
    this.refreshAnnotate(tab.path);
  }


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
    this.scheduleVcsDiff(path, 800);
    this.refreshAnnotate(path);
  }


  refreshVcsDecorations(): void {
    const tab = this.activeTab();
    if (tab) this.scheduleVcsDiff(tab.path, 100);
  }


  private diffDocument(tab: EditorTab): EditorDiffDocument {
    return {
      path: tab.path,
      languageId: tab.languageId,
      model: tab.model!,
      readOnly: tab.readOnly,
    };
  }

  private async toggleDiff(): Promise<void> {
    if (this.diffTogglePending) return;
    this.collaborativeView?.exit();
    const tab = this.activeTab();
    if (!tab?.model) return;
    this.diffTogglePending = true;
    try {
      await this.diffController.toggle(this.diffDocument(tab));
    } finally {
      this.diffTogglePending = false;
    }
  }


  private async toggleAnnotate(path: string): Promise<void> {
    const tab = this.tabByPath(path);
    if (!tab || this.annotateButton.classList.contains("is-running")) return;
    if (tab.annotated) {
      tab.annotated = false;
      tab.blame = null;
      tab.blameKind = null;
      if (this.activePath === path) this.applyLineNumberMode(true);
      this.updateEditorToggles();
      this.renderStatus();
      return;
    }
    if (!(await withButtonLoading(this.annotateButton, () => this.fetchBlame(tab, false)))) return;
    tab.annotated = true;
    if (this.activePath === path) this.applyLineNumberMode(true);
    this.updateEditorToggles();
    this.renderStatus();
  }

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

  private refreshAnnotate(path: string): void {
    const tab = this.tabByPath(path);
    if (!tab || !tab.annotated) return;
    void this.fetchBlame(tab, true).then((ok) => {
      if (!ok) return;
      if (this.activePath === tab.path) this.applyLineNumberMode();
    });
  }

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
          const label = blameGutterLabel(entry, kind).replace(/ /g, "\u00a0");
          return `${label}\u00a0\u00a0${n}`;
        },
        lineNumbersMinChars: Math.min(48, numWidth + 3 + maxLabel),
        lineDecorationsWidth: BLAME_LINE_DECORATIONS_WIDTH,
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

  private animateGutterShift(before: number): void {
    const editor = this.editor;
    if (!editor || this.motionReduced()) return;
    editor.render(true);
    const guard =
      editor.getDomNode()?.querySelector<HTMLElement>(".overflow-guard") ??
      null;
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

  private gutterWidthPx(): number {
    const margin =
      this.editor?.getDomNode()?.querySelector<HTMLElement>(".margin") ?? null;
    return margin ? margin.offsetWidth : 0;
  }

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

  private registerInlineCompletionMenu(): void {
    const editor = this.editor;
    if (!editor) return;
    this.inlineCompletionMenu?.dispose();
    const key = editor.createContextKey(
      "jellybot.aiCompletion",
      this.inlineCompletionEnabled,
    );
    this.inlineCompletionKey = key;
    const disable = editor.addAction({
      id: "jellybot.inlineCompletion.disable",
      label: "Disable AI Completion",
      precondition: "jellybot.aiCompletion",
      contextMenuGroupId: "z_completion",
      contextMenuOrder: 1,
      run: () => this.setInlineCompletion(false),
    });
    const enable = editor.addAction({
      id: "jellybot.inlineCompletion.enable",
      label: "Enable AI Completion",
      precondition: "!jellybot.aiCompletion",
      contextMenuGroupId: "z_completion",
      contextMenuOrder: 1,
      run: () => this.setInlineCompletion(true),
    });
    this.inlineCompletionMenu = {
      dispose: () => {
        disable.dispose();
        enable.dispose();
      },
    };
  }

  private setInlineCompletion(enabled: boolean): void {
    this.inlineCompletionEnabled = enabled;
    writeInlineCompletionEnabled(enabled);
    this.inlineCompletionKey?.set(enabled);
    this.editor?.updateOptions({ inlineSuggest: { enabled } });
    if (!enabled) {
      this.editor?.trigger("keyboard", "editor.action.inlineSuggest.hide", {});
    }
  }

  private setMinimap(enabled: boolean): void {
    this.minimapEnabled = enabled;
    try {
      if (enabled) localStorage.setItem(MINIMAP_KEY, "1");
      else localStorage.removeItem(MINIMAP_KEY);
    } catch {
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
      editor.updateOptions({ minimap: { enabled: true } });
      editor.render(true);
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
      if (this.minimapAnim !== anim) return;
      this.minimapAnim = null;
      this.editor?.updateOptions({ minimap: { enabled: false } });
      anim.cancel();
    };
  }

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
      if (!result.ok) return;
      tab.vcsDiff = result.diff;
      if (this.activePath === path) this.applyVcsDecorations();
    } catch {
    }
  }

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


  private renderTabs(): void {
    const scrollLeft = this.tabScroller.scrollLeft;
    this.tabScroller.replaceChildren();
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
      const onReferenceFile = this.options?.onReferenceFile;
      if (onReferenceFile) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "devmode-tab-reference";
        button.title = "Insert file reference";
        button.setAttribute("aria-label", `Insert file reference for ${tab.label}`);
        const icon = createLucideIcon(MessageSquareQuote, { size: 14 });
        icon.classList.add("devmode-tab-reference-icon");
        button.append(langIcon, icon);
        button.addEventListener("pointerdown", (event) => {
          if (event.button === 0) event.preventDefault();
        });
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          onReferenceFile(tab.path, tab.label);
        });
        button.addEventListener("dblclick", (event) => event.stopPropagation());
        el.append(button);
      } else {
        el.append(langIcon);
      }
      el.append(label, dot, close);
      el.addEventListener("click", () => {
        if (this.activePath === tab.path) {
          this.revealActiveTab();
          this.options?.onActiveTabChanged?.(tab.path, "tab");
          return;
        }
        this.activateTab(tab.path);
      });
      el.addEventListener("mouseenter", () => this.revealHoveredTab(el));
      el.addEventListener("auxclick", (event) => {
        if (event.button === 1) this.closeTab(tab.path);
      });
      el.addEventListener("dblclick", () => {
        void this.toggleCounterpartTab(tab.path);
      });
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (this.activePath !== tab.path) this.activateTab(tab.path);
        this.openTabMenu(event, tab.path);
      });
      this.tabScroller.append(el);
    }
    if (this.collaborativeView) this.tabScroller.append(this.collaborativeView.tab);
    this.tabScroller.scrollLeft = scrollLeft;
    this.editorHost.classList.toggle("is-visible", this.tabs.length > 0);
    this.emptyState.classList.toggle("is-visible", this.tabs.length === 0);
    this.revealActiveTab();
    this.updateTabNav();
    this.updateEditorToggles();
  }

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

  private revealHoveredTab(el: HTMLElement): void {
    const view = this.tabScroller.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const clippedLeft = view.left - rect.left;
    const clippedRight = rect.right - view.right;
    if (clippedLeft < 1 && clippedRight < 1) return;
    const delta = clippedLeft >= 1 ? -clippedLeft : clippedRight;
    if (this.motionReduced()) this.tabScroller.scrollLeft += delta;
    else
      this.tabScroller.scrollBy({ left: delta, behavior: "smooth" });
  }

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
    const root = this.options?.getWorkspaceRoot?.() ?? null;
    const sameRoot =
      root !== null &&
      this.clangdProgressRoot !== null &&
      root.replace(/\\/g, "/").replace(/\/+$/, "") ===
        this.clangdProgressRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const clangdParts = sameRoot
      ? formatClangdProgressParts(this.clangdProgress, Date.now(), tab?.path)
      : [];
    const progressParts: ClangdProgressPart[] =
      this.gotoWaitText.length > 0
        ? [{ key: "wait", text: this.gotoWaitText }]
        : clangdParts.length > 0
          ? clangdParts
          : this.symbolProgressText.length > 0
            ? [{ key: "symbol", text: this.symbolProgressText }]
            : [];
    const showProgress = progressParts.length > 0;
    this.indexingSpeedControl.update(
      root,
      sameRoot && (this.clangdProgress.index !== null || this.clangdProgress.indexLoadingSince !== null),
      sameRoot ? this.clangdProgress.indexingSpeed : "normal",
    );
    this.statusCarousel.setItems(showProgress ? progressParts : []);
    this.statusIndex.title = progressParts.map(part => part.text).join("\n");
    this.statusIndex.hidden = !showProgress;
    this.statusBar.classList.toggle(
      "is-visible",
      showProgress || tab !== null,
    );
    if (!tab) {
      this.statusNotice.textContent = "";
      return;
    }
    this.statusNotice.textContent = this.notice ?? "";
  }

  mountStatusBar(host: HTMLElement): void {
    this.statusBar.classList.add("is-panel-inline");
    host.append(this.statusBar);
    this.renderStatus();
  }

  get activeEditor(): MonacoTypes.editor.IStandaloneCodeEditor | null {
    return this.diffController.isEnabled
      ? this.diffController.modifiedEditor
      : this.editor;
  }

  get monacoApi(): MonacoApi | null {
    return this.monaco;
  }

  get activeModel(): MonacoTypes.editor.ITextModel | null {
    return this.activeTab()?.model ?? null;
  }

  getOpenFiles(): { activeFile: string | null; openFiles: string[] } {
    return {
      activeFile: this.activeTab()?.path ?? null,
      openFiles: this.tabs.map((tab) => tab.path),
    };
  }

  getQuickOpenRecentFiles(): string[] {
    const active = this.activeTab();
    return [...new Set([...(active ? [active.path] : []), ...this.tabs.slice().reverse().map(tab => tab.path)])];
  }

  getDocumentText(path: string): string | null {
    const tab = this.tabByPath(path);
    if (!tab) return null;
    return tab.model?.getValue() ?? tab.pendingContent;
  }

  getActiveDocument(): { path: string; text: string } | null {
    const tab = this.activeTab();
    if (!tab) return null;
    const text = tab.model?.getValue() ?? tab.pendingContent;
    if (text === null) return null;
    return { path: tab.path, text };
  }

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
      return;
    }
    this.clangdTipRemover = () => {
      try {
        editor.removeContentWidget(widget);
      } catch {
      }
    };
  }

  private hideClangdSearchTip(): void {
    this.clangdTipRemover?.();
    this.clangdTipRemover = null;
  }

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
      const anchor = this.semanticAnchor(editor, model, position);
      const caret = {
        path: modelUriToPath(model.uri) ?? "",
        line: anchor.lineNumber,
      };
      const root = this.options?.getWorkspaceRoot?.();
      const cancel = new AbortController();
      let userCancelled = false;
      const onEsc = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        userCancelled = true;
        cancel.abort();
      };
      if (root) {
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
          await this.revealFileLine(landing.path, landing.line, undefined, {
            revealInTree: true,
          });
          return;
        }
        if ((semantic?.length ?? 0) > 0 || (targets?.length ?? 0) > 0) {
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
  }

  async resolveCppUsageTarget(): Promise<CppUsageTarget | null> {
    const model = this.editor?.getModel();
    const position = this.editor?.getPosition();
    const editor = this.editor;
    if (!model || !position || !editor || !this.cppFeatures) return null;
    if (model.getLanguageId() !== "cpp") return null;
    const anchor = this.semanticAnchor(editor, model, position);
    return await this.cppFeatures.resolveUsageTarget(model, anchor);
  }

  async revealFileLine(
    path: string,
    line?: number,
    column?: number,
    options?: { revealInTree?: boolean },
  ): Promise<void> {
    await this.openFile(path, options);
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
