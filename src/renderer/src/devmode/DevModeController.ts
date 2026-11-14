/**
 * Dev Mode controller (plan: dev-mode-v1).
 *
 * Owns the workbench lifecycle inside the shell: mounts the Solution Outline
 * host into the shell sidebar slot and the three-column workbench into the
 * main slot, swaps ConversationControllers in the chat pane as sessions
 * open/switch, and drives the editor|chat splitter (persisted width).
 *
 * s6 replaces the outline placeholder; s7 the editor pane; s8 wires the
 * session dropdown + preview interception.
 */
import { ConversationController } from "../screens/conversation/ConversationController.js";
import { setEditorContextProvider } from "../state/editorContextState.js";
import { ConversationView } from "../screens/conversation/ConversationView.js";
import { NewTaskController } from "../screens/new-task/NewTaskController.js";
import { NewTaskView } from "../screens/new-task/NewTaskView.js";
import type { PendingAttachment } from "../ui/taskComposer/bindComposerAttachments.js";
import { EditorAreaController } from "./EditorAreaController.js";
import type { AgentReadRange } from "./agentFlash.js";
import type { AgentWriteFilePlan } from "../screens/conversation/cards/toolInvocationHelpers.js";
import { DebugController } from "./DebugController.js";
import { DebugConsoleController } from "./DebugConsoleController.js";
import { DebugConsoleView } from "./DebugConsoleView.js";
import { DebugPanelView } from "./DebugPanelView.js";
import { FindWidgetController } from "./FindWidgetController.js";
import {
  computeEditorStatusMode,
  ContextPillController,
} from "./contextPill.js";
import { FindUsagesController } from "./FindUsagesController.js";
import { clangdAvailable, resetClangdAvailabilityCache } from "./clangdFeatures.js";

/** Identifier at a 1-based line/column, for view titles. */
function wordAt(text: string, line: number, column: number): string {
  const lineText = text.split(/\r?\n/)[line - 1] ?? "";
  const before = lineText.slice(0, Math.max(0, column - 1));
  const after = lineText.slice(Math.max(0, column - 1));
  const left = /[A-Za-z_0-9]*$/.exec(before)?.[0] ?? "";
  const right = /^[A-Za-z_0-9]*/.exec(after)?.[0] ?? "";
  return left + right || "symbol";
}
import { FindUsagesView } from "./FindUsagesView.js";
import { findWidgetHotkey } from "./findReplace.js";
import { isDevModalOpen } from "./modalLayer.js";
import { isImagePath } from "./languages.js";
import { QuickOpenController } from "./QuickOpenController.js";
import { resolveWorkspaceFilePath } from "./slnPaths.js";
import { SolutionOutlineController } from "./SolutionOutlineController.js";
import { resolveCppCounterpart } from "./cppCounterpart.js";
import { DocumentOutlineController } from "./DocumentOutlineController.js";
import { TerminalPaneController } from "./TerminalPaneController.js";
import { TerminalPaneView } from "./TerminalPaneView.js";
import { UnifiedPanelController } from "./UnifiedPanelController.js";
import { WorkbenchView } from "./WorkbenchView.js";
import { DevModeNavigationController } from "./DevModeNavigationController.js";

export type DevModeSessionOpenOptions = {
  optimisticUserText?: string;
  attachments?: PendingAttachment[];
  /** Workspace the session was started in (New Task passes it through). */
  workspaceId?: string | null;
};

export type DevModeDeps = {
  /** Display title for a session id (shell's sidebar session state). */
  getSessionTitle: (sessionId: string) => string | undefined;
  /** Session picked via the chat header dropdown or started from New Task. */
  onOpenSession: (
    sessionId: string,
    options?: DevModeSessionOpenOptions,
  ) => void;
  /** Pull & Merge conflicts → shell creates the resolution session + CoCo. */
  onPullMergeSession?: (sessionId: string, conflicts: string[], repoRoot: string) => void;
  /** New Task picked another workspace → sidebar state refresh. */
  onWorkspaceChanged?: () => void;
  /** File-tree header "+" opens the shared workspace creation flow. */
  onCreateWorkspace: (anchor: HTMLButtonElement) => void;
  /** session → workspace folder path (session → workspaceId → path). */
  getSessionWorkspacePath: (sessionId: string) => string | null;
  /**
   * Non-archived sessions of a workspace (header dropdown groups). Status
   * drives the running spinner; updatedAt drives turn-end re-sorting.
   */
  getWorkspaceSessions: (wsId: string) => Array<{
    id: string;
    title: string;
    status?: string;
    updatedAt: number;
  }>;
  /** Archive a session from the switcher dropdown (sidebar parity). */
  onArchiveSession?: (sessionId: string) => void;
  /** Delete a session from the switcher dropdown (sidebar parity). */
  onDeleteSession?: (sessionId: string) => void;
  /** Default workspace when Dev Mode starts without an open task. */
  getActiveWorkspaceId?: () => string | null;
  /** Keep shell focus in step when the pane displays a workspace's New Task. */
  onNewTask?: (workspaceId: string | null) => void;
  /** All non-archived workspaces — the project switcher list. */
  getWorkspaces: () => Array<{ id: string; name: string; path: string }>;
  /** `/dev` inside the workbench — exit back to the normal layout. */
  onExitDevMode?: () => void;
};

const CHAT_WIDTH_KEY = "jellybot.devmode.chatWidth";
const CHAT_COLLAPSED_KEY = "jellybot.devmode.chatCollapsed";
const DEFAULT_CHAT_WIDTH = 380;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 640;

function clampChatWidth(px: number): number {
  return Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, Math.round(px)));
}

function readChatWidth(): number {
  try {
    const raw = localStorage.getItem(CHAT_WIDTH_KEY);
    if (!raw) return DEFAULT_CHAT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? clampChatWidth(n) : DEFAULT_CHAT_WIDTH;
  } catch {
    return DEFAULT_CHAT_WIDTH;
  }
}

function writeChatWidth(px: number): void {
  try {
    localStorage.setItem(CHAT_WIDTH_KEY, String(clampChatWidth(px)));
  } catch {
    // ignore quota / private mode
  }
}

function readChatCollapsed(): boolean {
  try {
    return localStorage.getItem(CHAT_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeChatCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(CHAT_COLLAPSED_KEY, "1");
    else localStorage.removeItem(CHAT_COLLAPSED_KEY);
  } catch {
    // ignore quota / private mode
  }
}

export class DevModeController {
  private unregisterEditorContext: (() => void) | null = null;
  private readonly view = new WorkbenchView();
  private readonly navigation: DevModeNavigationController;
  private readonly outline: SolutionOutlineController;
  private readonly editorArea = new EditorAreaController({
    // Tab focus syncs the outline: expand → select → scroll into view.
    // Close successions get the same full reveal — the tree should land on
    // the file that now fills the editor. Other activation paths (tree
    // click, Quick Open) sync the selection in place — no expand, no jump.
    onActiveTabChanged: (path, source) => {
      if (source === "tab" || source === "close") {
        void this.outline.revealPath(path);
      } else {
        this.outline.syncSelection(path);
      }
      // Find widget follows the tab switch (decorations die with the model).
      this.find.notifyModelChanged();
      void this.docOutline.refresh();
    },
    // Tab menu "Reveal in File Tree", and F12 / Ctrl+click landings.
    onRevealInTree: (path) => void this.outline.revealPath(path),
    // Workspace root for the editor's VCS gutter marks.
    getWorkspaceRoot: () =>
      this.sessionId ? this.deps.getSessionWorkspacePath(this.sessionId) : null,
    getSessionId: () => this.sessionId,
    // Diff needs the full editor width. Exiting does not reopen chat because
    // that would override an explicit user layout choice.
    onDiffModeChanged: (enabled) => {
      if (enabled) this.setChatCollapsed(true);
    },
    onBreakpointToggle: (path, line) => this.debug.toggleBreakpoint(path, line),
    onBreakpointCondition: (path, line) => {
      void this.debug.editBreakpointCondition(path, line);
    },
    onDebugHover: (expression) => this.debug.evaluateHover(expression),
    onDebugVariables: (variablesReference) =>
      this.debug.expandHoverVariable(variablesReference),
    onDocumentChanged: () => this.docOutline.scheduleRefresh(),
    onCursorLineChanged: (line) => this.docOutline.setCursorLine(line),
    // F12 miss → Quick Open symbol search seeded with the identifier.
    onOpenSymbolSearch: (query) => this.quickOpen.open(query),
    // Counterpart toggle (tab double-click): basename hits from the loaded
    // Quick Open file index — same data Ctrl+T searches, engine included.
    queryFileIndex: (base) => this.quickOpen.filesByBasename(base),
    onFindUsages: () => void this.usages.find(),
  });
  /** Document Outline — declarations in the active editor file. */
  private readonly docOutline = new DocumentOutlineController({
    getActiveDocument: () => this.editorArea.getActiveDocument(),
    readFile: async (path) => {
      const live = this.editorArea.getDocumentText(path);
      if (live !== null) return live;
      const bridge = window.jellybot;
      if (!bridge?.readFileForEditor) return null;
      try {
        const result = await bridge.readFileForEditor(path);
        return result.ok ? result.content : null;
      } catch {
        return null;
      }
    },
    revealLine: (path, line) => {
      void this.editorArea.revealFileLine(path, line);
    },
    resolveHeader: (sourcePath) =>
      resolveCppCounterpart(
        sourcePath,
        (root, query, options) =>
          window.jellybot?.searchDevModeFiles?.(root, query, options),
        (paths) => window.jellybot?.filterExistingFiles?.(paths),
        (base) => this.quickOpen.filesByBasename(base),
      ),
  });
  /** Unified bottom panel (Terminal / Build / Run tabs) — one strip. */
  private readonly panel = new UnifiedPanelController();
  private readonly debug: DebugController;
  private readonly debugConsole: DebugConsoleController;
  /** Terminal run logic — drives the panel's terminal view (main-side runs). */
  private readonly terminal = new TerminalPaneController(
    this.panel.terminalView,
    // Agent shell mirror auto-open (any chat state) — never steals focus.
    { openPanel: () => this.panel.revealTerminal(false) },
  );
  private readonly quickOpen: QuickOpenController;
  /** Custom ⌘F find widget (replaces Monaco's built-in). */
  private readonly find: FindWidgetController;
  /** Top context pill — latest prompt / active task over the editor pane. */
  private readonly contextPill: ContextPillController;
  /**
   * Editor status strip — spinner + live progress over the editor pane,
   * visible only while the chat pane is collapsed (the chat-side pill owns
   * the prompt/plan content).
   */
  private readonly statusPill: ContextPillController;
  private readonly usages: FindUsagesController;
  private chat: ConversationController | null = null;
  private newTask: NewTaskController | null = null;
  private sessionId: string | null = null;
  private workspacePath: string | null = null;
  /**
   * Monotonic token for in-flight {@link applyWorkspace} calls — the outline
   * scan is slow, and a superseded switch must not touch the panel / editor
   * tabs after a newer one already applied them.
   */
  private wsApplyGen = 0;
  private requestedWorkspacePath: string | null | undefined;
  /** DAP source path → local file, keyed by `workspace\0 dap path`. */
  private readonly debugSourcePaths = new Map<string, Promise<string>>();
  private watchedPath: string | null = null;
  private unwatchFsEvents: (() => void) | null = null;
  private unwatchVcsChanges: (() => void) | null = null;
  /**
   * Serialized agent auto-opens (write_file / patch finished): each open
   * must observe the previous one's eviction, or a multi-file burst would
   * all pass the tab-cap check before any tab lands.
   */
  private agentOpenChain: Promise<void> = Promise.resolve();
  private chatWidth = DEFAULT_CHAT_WIDTH;
  private dragging = false;
  private startX = 0;
  private startWidth = 0;
  /** ⌘T / Ctrl+T — Quick Open. ⌘F / Ctrl+F — Find. Ctrl+H / ⌘⌥F — Replace. */
  private readonly keydown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return;
    // A modal covers the workbench — don't focus overlays behind it.
    if (isDevModalOpen()) return;
    const key = event.key.toLowerCase();
    if (key === "t" && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (this.find.isOpen) this.find.close();
      this.quickOpen.toggle();
      return;
    }
    const findCmd = findWidgetHotkey(event);
    if (!findCmd) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.quickOpen.isOpen) this.quickOpen.close();
    this.find.open(findCmd);
  };
  private readonly onPointerMove = (event: PointerEvent) =>
    this.handlePointerMove(event);
  private readonly onPointerUp = (event: PointerEvent) =>
    this.handlePointerUp(event);

  constructor(private readonly deps: DevModeDeps) {
    this.navigation = new DevModeNavigationController(this.view, {
      getWorkspaces: deps.getWorkspaces,
      getWorkspaceSessions: deps.getWorkspaceSessions,
      onWorkspaceSelected: (id) => this.switchWorkspace(id),
      onCreateWorkspace: deps.onCreateWorkspace,
      onOpenSession: (id) => deps.onOpenSession(id),
      onNewTask: () => this.startNewSession(),
      onArchiveSession: deps.onArchiveSession,
      onDeleteSession: deps.onDeleteSession,
    });
    const debugView = new DebugPanelView();
    const debugConsoleView = new DebugConsoleView();
    this.debugConsole = new DebugConsoleController(debugConsoleView);
    this.debug = new DebugController(debugView, {
      getWorkspacePath: () => this.workspacePath,
      setEditorBreakpoints: (breakpoints) =>
        this.editorArea.setDebugBreakpoints(breakpoints),
      setEditorExecutionLocation: (path, line) => {
        if (path && line) this.editorArea.setDebugExecutionLocation(path, line);
        else this.editorArea.setDebugExecutionLocation(null);
      },
      setEditorFrameLocation: (path, line) => {
        if (path && line) this.editorArea.setDebugFrameLocation(path, line);
        else this.editorArea.setDebugFrameLocation(null);
      },
      revealPanel: () => this.panel.revealDebug(),
      revealFileLine: (path, line) => this.editorArea.revealFileLine(path, line),
      resolveSourcePath: (path) => this.resolveDebugSourcePath(path),
      // A live session keeps the Debug tabs reachable for Stop while the
      // user is in another workspace.
      onSessionLive: (live) => this.panel.setDebugSessionLive(live),
      onSnapshot: snapshot => this.editorArea.setUnrealDebugState(snapshot),
      getDebugSourceRoots: () => this.editorArea.getUnrealSourceRoots(),
    });
    this.panel.installDebugView(debugView.root);
    this.panel.installDebugConsoleView(debugConsoleView.root);
    this.panel.debugConsoleControllerClear = () => {
      this.debugConsole.clear();
    };
    const usagesView = new FindUsagesView();
    this.usages = new FindUsagesController(usagesView, {
      getTarget: () => this.editorArea.resolveCppUsageTarget(),
      getSemanticReferences: async () => {
        const caret = this.editorArea.getCaretDocument();
        if (!caret || !this.workspacePath) return null;
        if (caret.languageId !== "cpp") return null;
        const active = this.editorArea.getActiveDocument();
        const bridge = window.jellybot;
        if (!bridge?.clangdReferences) return null;
        try {
          if (!(await clangdAvailable(this.workspacePath))) return null;
          const result = await bridge.clangdReferences(this.workspacePath, {
            path: caret.path,
            line: caret.line,
            column: caret.column,
            ...(active && active.path === caret.path
              ? { text: active.text }
              : { text: caret.text }),
          });
          if (!result.ok) return null;
          const references = result.references ?? [];
          return {
            word: wordAt(caret.text, caret.line, caret.column),
            references: references.map((ref) => ({
              path: ref.path,
              line: ref.line,
              column: ref.column,
            })),
          };
        } catch {
          return null;
        }
      },
      getWorkspaceRoot: () => this.workspacePath,
      getActiveDocument: () => this.editorArea.getActiveDocument(),
      getLiveText: (path) => this.editorArea.getDocumentText(path),
      readText: async (path) => {
        const bridge = window.jellybot;
        if (!bridge) return null;
        try {
          const result = await bridge.readFileForEditor(path);
          return result.ok ? result.content : null;
        } catch {
          return null;
        }
      },
      lookupSymbols: async (word) => {
        const bridge = window.jellybot;
        if (!this.workspacePath || !bridge) return [];
        try {
          return await bridge.lookupCppSymbols(this.workspacePath, word);
        } catch {
          return [];
        }
      },
      revealFileLine: (path, line, column) =>
        void this.editorArea.revealFileLine(path, line, column),
      revealPanel: () => this.panel.revealReferences(),
    });
    this.panel.installReferencesView(usagesView.root);
    this.panel.referencesControllerClear = () => this.usages.clear();
    this.quickOpen = new QuickOpenController({
      getRecentFiles: () => this.editorArea.getQuickOpenRecentFiles(),
      openFile: (path, line) => {
        if (line === undefined) void this.editorArea.openFile(path);
        else void this.editorArea.revealFileLine(path, line);
      },
      getWorkspaceRoot: () => this.workspacePath,
    });
    this.find = new FindWidgetController(this.editorArea);
    this.contextPill = new ContextPillController();
    this.statusPill = new ContextPillController({
      computeMode: computeEditorStatusMode,
      // Editor status strip is transient progress — no fold affordance.
      foldable: false,
      // Turn end → green-check "Done" dwell (3s) + scale/fade leave.
      doneFade: true,
    });
    this.outline = new SolutionOutlineController({
      onOpenFile: (path) => void this.editorArea.openFile(path),
      // Outline re-ran `status` → editor gutter marks may be stale.
      onVcsRefreshed: () => this.editorArea.refreshVcsDecorations(),
      // Build clicked → reveal the unified panel on the Build tab. The
      // workspace re-assert heals a panel stranded on another project by
      // an interrupted switch before the reveal.
      onTaskRun: (task) => {
        this.panel.ensureWorkspace(this.workspacePath);
        this.panel.revealForTask(task);
      },
      // Debug recipe resolved → mirror into the editor launch cluster.
      onDebugAvailable: (available, kind) => {
        this.panel.setDebugAvailable(available, kind);
        this.editorArea.setDebugEnabled(available);
        this.editorArea.setDebugRecipe(kind);
        // Unreal Build is UBT-injected — `.larry/tasks.json` is not the
        // configure surface, so hide the gear rather than leave a dead control.
        this.editorArea.setConfigVisible(kind !== "unreal");
      },
      onDeployConfigChange: (command) => {
        this.editorArea.setDeployCommand(command);
        this.panel.ensureWorkspace(this.workspacePath);
        this.panel.setDeployAvailable(command !== null);
      },
      // Build run state → launch cluster spinner/pip.
      onTaskStateChange: (task, running, failed) => {
        if (task === "build") this.editorArea.setBuildState(running, failed);
        if (task === "deploy") this.editorArea.setDeployState(running, failed);
      },
      // Build title (command / config status) → launch cluster tooltip.
      onBuildTitleChange: (title) => this.editorArea.setBuildTitle(title),
      // Path-scoped commits from the tree context menu guard on chat state.
      isChatBusy: () => this.chat?.isBusy() ?? false,
    });
    this.navigation.workspaceActions.prepend(this.outline.refreshButton);
    // Editor launch cluster → build/debug/config actions.
    this.editorArea.onBuildClick = () => this.outline.runBuild();
    this.editorArea.onDeployClick = () => this.outline.runDeploy();
    this.editorArea.onDebugClick = (buildId) => {
      void this.debug.start(buildId);
    };
    this.editorArea.onDebugStop = () => { void this.debug.stop(); };
    this.editorArea.onTaskLaunch = task => {
      this.panel.ensureWorkspace(this.workspacePath);
      this.panel.revealForTask(task);
    };
    this.editorArea.onConfigClick = () => {
      void this.outline.openTaskConfig();
    };
  }

  mount(sidebarHost: HTMLElement, mainHost: HTMLElement): void {
    const stack = document.createElement("div");
    stack.className = "devmode-sidebar-stack";
    // Sidebar = two cards, not one: the workspace header + file tree share a
    // card, the document outline is its own card below it, and the outline's
    // resize handle sits in the gutter between them.
    const filesCard = document.createElement("div");
    filesCard.className = "devmode-files-card";
    filesCard.append(this.navigation.workspaceHeader, this.outline.root);
    stack.append(
      filesCard,
      this.docOutline.view.resizeHandle,
      this.docOutline.view.root,
    );
    sidebarHost.replaceChildren(stack);
    mainHost.replaceChildren(this.view.root);
    this.editorArea.mount(this.view.editorPane);
    this.unregisterEditorContext?.();
    this.unregisterEditorContext = setEditorContextProvider(() =>
      this.editorArea.getOpenFiles(),
    );
    // The collapsed panel toolbar is always present and owns file status.
    this.panel.mount(this.view.editorPane);
    this.editorArea.mountStatusBar(this.panel.statusHost);
    // Quick Open overlay — spans the editor pane (tab bar excluded).
    this.quickOpen.mount(this.view.editorPane);
    // Custom find / replace widget — same overlay slot as Quick Open.
    this.find.mount(this.view.editorPane);
    // Top context pill (latest prompt / active task) — floats at the top
    // of the chat pane, below its header; folds automatically while the
    // prompt bubble is on screen (snapshot.promptVisible).
    this.contextPill.mount(this.view.chatPane);
    // Editor status strip — same top slot family as Quick Open, but only
    // while the chat pane is collapsed (gate flips in setChatCollapsed).
    this.statusPill.mount(this.view.editorPane);
    this.statusPill.setGate(readChatCollapsed());
    // ⌘T works anywhere in Dev Mode (editor/tree/chat), capture-phase.
    window.addEventListener("keydown", this.keydown, true);
    // Chat expand rides the editor's fab row (minimap, annotate, expand).
    this.editorArea.appendFab(this.view.chatExpandButton);
    // The shared toolbar's Stop still routes to the terminal run controller.
    this.panel.terminalControllerStop = () => this.terminal.requestStop();
    this.debug.mount();
    this.debugConsole.mount();
    this.wireSplitter();
    // Header "+" — New Task pinned to the active workspace (or the picker
    // when no workspace context). Sessions switcher stays in the dropdown.
    this.view.chatNewSessionButton.addEventListener("click", () => {
      this.startNewSession();
    });
    this.setChatCollapsed(readChatCollapsed());
    this.view.chatCollapseButton.addEventListener("click", () => {
      this.setChatCollapsed(true);
    });
    this.view.chatExpandButton.addEventListener("click", () => {
      this.setChatCollapsed(false);
    });

    const bridge = window.jellybot;
    if (bridge?.onDevModeFsEvent) {
      this.unwatchFsEvents = bridge.onDevModeFsEvent((payload) => {
        this.outline.handleFsEvent(payload);
        this.editorArea.refreshUnrealFiles(payload.events);
        this.editorArea.handleFsEvent(payload);
      });
    }
    if (bridge?.onVcsChanged) {
      // Commits only touch .git/.svn (fs watcher filters dot-dirs) — main
      // watches the metadata dirs and pushes this explicit refresh signal.
      this.unwatchVcsChanges = bridge.onVcsChanged(({ rootPath }) => {
        if (
          this.workspacePath &&
          rootPath.replace(/\\/g, "/") ===
            this.workspacePath.replace(/\\/g, "/")
        ) {
          this.outline.handleVcsChanged();
          this.editorArea.refreshVcsDecorations();
        }
      });
    }
  }

  /**
   * No session context (empty workspace): embed the New Task form in the
   * chat pane — submitting it starts a session that takes over the pane.
   * `fixedWorkspaceId` (dropdown "+ New Task") locks the project picker
   * to the open session's workspace.
   */
  showNewTask(fixedWorkspaceId?: string | null): void {
    const workspaces = this.deps.getWorkspaces();
    const requested = fixedWorkspaceId ?? this.navigation.workspace?.id ?? this.deps.getActiveWorkspaceId?.();
    const workspace = workspaces.find((item) => item.id === requested) ?? workspaces[0];
    this.navigation.closeMenus();
    this.chat?.destroy();
    this.chat = null;
    this.newTask?.destroy();
    const view = new NewTaskView();
    // The tree header owns project selection; an empty installation still needs
    // the first-workspace flow offered by New Task.
    view.setWorkspacePickerVisible(!workspace);
    const newTask = new NewTaskController(view, {
      onSessionStarted: (sessionId, options) => this.deps.onOpenSession(sessionId, options),
      onWorkspaceChanged: () => this.deps.onWorkspaceChanged?.(),
      fixedWorkspaceId: workspace?.id ?? null,
      draftKey: workspace ? "devmode:new-task:" + workspace.id : undefined,
    });
    this.view.chatHost.replaceChildren(newTask.mount());
    this.newTask = newTask;
    this.sessionId = null;
    this.navigation.setContext(workspace?.path ?? null, null);
    this.deps.onNewTask?.(workspace?.id ?? null);
    this.terminal.setMirrorSession(null);
    this.contextPill.reset();
    this.statusPill.reset();
    this.updateChatTitle();
    this.view.setChatHasSession(true);
    void this.applyWorkspace(workspace?.path ?? null);
  }

  /**
   * ⌘W / Ctrl+F4 while Dev Mode is up: close the active file tab, one per
   * press. True = consumed (the window stays); false = no tabs left, so
   * the caller closes the window instead.
   */
  closeActiveTab(): boolean {
    return this.editorArea.closeActiveTab();
  }

  /** Task identity only — workspace selection lives above the file tree. */
  private updateChatTitle(): void {
    const suffix = this.sessionId
      ? (this.deps.getSessionTitle(this.sessionId) ?? "Task")
      : this.newTask
        ? "New Task"
        : "No task";
    this.view.setChatTitle(suffix);
  }

  /** Collapse/expand the chat pane; persisted across Dev Mode entries. */
  private setChatCollapsed(collapsed: boolean): void {
    this.view.setChatCollapsed(collapsed);
    // The chat segment animates open/closed inside the merged pill
    // (.is-in drives the width/opacity transition; aria-hidden + tabIndex
    // keep the collapsed stub out of the a11y/focus tree).
    this.view.chatExpandButton.classList.toggle("is-in", collapsed);
    this.view.chatExpandButton.setAttribute("aria-hidden", String(!collapsed));
    this.view.chatExpandButton.tabIndex = collapsed ? 0 : -1;
    // With the chat pane hidden its context pill goes too — the editor
    // status strip takes over (spinner + live progress).
    this.statusPill.setGate(collapsed);
    writeChatCollapsed(collapsed);
  }

  /** Shell calls this when the session list changes (sidebar refresh). */
  notifySessionsChanged(): void {
    if (this.sessionId) {
      this.updateChatTitle();
      const path = this.deps.getSessionWorkspacePath(this.sessionId);
      if (path) {
        this.navigation.setContext(path, this.sessionId);
        if (path !== this.workspacePath) void this.applyWorkspace(path);
      }
    } else if (this.newTask && !this.navigation.workspace && this.deps.getWorkspaces().length) {
      // The first workspace was just created from the initial New Task form.
      this.showNewTask(this.deps.getActiveWorkspaceId?.());
    }
    this.navigation.refresh();
  }

  private startNewSession(): void {
    this.showNewTask(this.navigation.workspace?.id ?? null);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Swap the chat pane conversation (mirrors the shell's main-slot flow). */
  setSession(
    sessionId: string | null,
    options?: DevModeSessionOpenOptions,
  ): void {
    this.chat?.destroy();
    this.chat = null;
    this.newTask?.destroy();
    this.newTask = null;
    this.sessionId = sessionId;
    this.navigation.setContext(
      sessionId ? this.resolveSessionWorkspacePath(sessionId, options?.workspaceId) : null,
      sessionId,
    );
    // Terminal panel mirrors the Dev Mode conversation's agent shell calls.
    this.terminal.setMirrorSession(sessionId);
    if (!sessionId) {
      this.view.setChatHasSession(false);
      this.updateChatTitle();
      this.contextPill.reset();
      this.statusPill.reset();
      void this.applyWorkspace(null);
      return;
    }
    this.contextPill.reset();
    this.statusPill.reset();
    const conversation = new ConversationController(
      new ConversationView(),
      sessionId,
      {
        ...options,
        // Dev Mode: chat file previews open in the editor pane (s8 bus).
        // Images keep the normal-mode File Reader window — Monaco cannot
        // render them (readFileForEditor rejects binary content).
        onOpenFile: (path) => void this.openChatFile(path),
        // Agent write_file / patch finished → open the touched files in
        // the editor pane (tab-capped, oldest clean tab evicted) and flash
        // the changed lines (add green / del red, patch hunks).
        onFileWritten: (files) => this.openAgentWrittenFiles(files),
        // Agent read_file finished → open the file and flash the read
        // span (blue) so the user sees exactly what the agent saw.
        onFileRead: (path, range) => this.openAgentReadFile(path, range),
        // `/dev` inside the workbench exits back to the normal layout.
        onToggleDevMode: () => this.deps.onExitDevMode?.(),
        // Top pills — one snapshot drives both: chat pane (prompt/plan)
        // and the editor status strip (progress, chat-collapsed only).
        onContextPill: (snapshot) => {
          this.contextPill.update(snapshot);
          this.statusPill.update(snapshot);
        },
        // Command feedback notices: the chat pill owns them; the editor
        // strip mirrors (gate shows it only while the chat pane is
        // collapsed, so feedback survives a collapsed chat).
        onPillNotice: (text, ms, spinner) => {
          const opts = spinner === true ? { spinner: true } : undefined;
          this.contextPill.showNotice(text, ms, opts);
          this.statusPill.showNotice(text, ms, opts);
        },
      },
    );
    // Pull & Merge conflicts route to the shell (workspace lookup + CoCo
    // hand-over + openSession), mirroring the normal-layout conversation.
    conversation.onPullMergeSession = (conflicts, repoRoot) => {
      this.deps.onPullMergeSession?.(sessionId, conflicts, repoRoot);
    };
    this.view.chatHost.replaceChildren(conversation.mount());
    this.chat = conversation;
    this.updateChatTitle();
    this.view.setChatHasSession(true);
    // Prefer the workspace New Task started the session with: resolving via
    // the session list right after creation misses (sidebar refresh lags)
    // and applyWorkspace(null) would tear the tree/editor down for a beat
    // before notifySessionsChanged rebuilds them — the visible refresh.
    void this.applyWorkspace(
      this.resolveSessionWorkspacePath(sessionId, options?.workspaceId),
    );
  }

  /**
   * Session → workspace path. The explicit id (New Task) wins — the
   * workspaces state it was picked from is current; the session list is
   * not, yet.
   */
  private resolveSessionWorkspacePath(
    sessionId: string,
    explicitWorkspaceId?: string | null,
  ): string | null {
    if (explicitWorkspaceId) {
      const ws = this.deps
        .getWorkspaces()
        .find((w) => w.id === explicitWorkspaceId);
      if (ws) return ws.path;
    }
    return this.deps.getSessionWorkspacePath(sessionId) ?? null;
  }

  /**
   * Chat file-click routing (end-of-turn file card Preview): images → the
   * dedicated File Reader window (same as normal mode); everything else →
   * the workbench editor pane.
   */
  private openChatFile(path: string): void {
    if (isImagePath(path)) {
      try {
        void window.jellybot?.openFileReader?.(path);
      } catch (err) {
        console.error("[devmode] openFileReader failed", err);
      }
      return;
    }
    void this.editorArea.openFile(path);
  }

  /**
   * write_file / patch finished — open the touched files in the editor
   * pane and flash each file's changed lines. Paths resolve against the
   * workspace root the write was enqueued in; a project switch mid-chain
   * drops the rest (they belong to the old project and must not leak into
   * the new one's tab strip).
   *
   * Replace-mode writes carry no hunks (ranges empty): the opened file
   * gets a whole-file green wash plus a one-shot pulse on its tab — same
   * "the agent touched this" signal the patch hunks give.
   */
  private openAgentWrittenFiles(files: AgentWriteFilePlan[]): void {
    const root = this.workspacePath;
    for (const file of files) {
      const path = resolveWorkspaceFilePath(file.path, root);
      if (path === null) continue;
      this.agentOpenChain = this.agentOpenChain
        .then(() => {
          if (this.workspacePath !== root) return;
          return this.editorArea.openAgentFile(path);
        })
        .then(() => {
          if (this.workspacePath !== root) return;
          if (file.ranges.length > 0) {
            this.editorArea.flashLineRanges(path, file.ranges);
          } else {
            this.editorArea.flashLineRanges(path, [
              { start: 1, end: null, kind: "write" },
            ]);
            this.editorArea.pulseTab(path);
          }
        })
        .catch(() => undefined);
    }
  }

  /**
   * read_file finished — open the file (same tab cap as writes) and flash
   * the span that was read. Same workspace-root guard as writes: a project
   * switch mid-chain drops the read.
   */
  private openAgentReadFile(rawPath: string, range: AgentReadRange): void {
    const root = this.workspacePath;
    const path = resolveWorkspaceFilePath(rawPath, root);
    if (path === null) return;
    this.agentOpenChain = this.agentOpenChain
      .then(() => {
        if (this.workspacePath !== root) return;
        return this.editorArea.openAgentFile(path);
      })
      .then(() => {
        this.editorArea.flashLineRanges(path, [
          { start: range.start, end: range.end, kind: "read" },
        ]);
      })
      .catch(() => undefined);
  }

  /** session → workspace: outline scan + recursive watch lifecycle. */
  private async applyWorkspace(path: string | null): Promise<void> {
    // Same-root task switches share the in-flight tree/tab restoration. A
    // different request supersedes the old one before the first async boundary.
    if (path !== this.requestedWorkspacePath) {
      this.requestedWorkspacePath = path;
      this.wsApplyGen += 1;
    }
    const gen = this.wsApplyGen;
    await this.debug.setWorkspace(path);
    if (gen !== this.wsApplyGen) return;
    this.syncWatch(path);
    this.terminal.setWorkspace(path);
    if (path === this.workspacePath) {
      // Same workspace — but a superseded switch may have stranded the
      // panel on another project (its setWorkspace was skipped by the
      // generation check); re-assert. No-op when already in step.
      this.panel.ensureWorkspace(path);
      return;
    }
    // From here this call owns the switch. The outline scan below can take
    // seconds on a large tree — a newer applyWorkspace (user switched again)
    // must supersede us: without the generation check, the stale call would
    // reset the panel to the OLD workspace after the fresh one already
    // replayed a running build into it (empty Build tab, spinner button).
    this.workspacePath = path;
    void this.editorArea.setUnrealWorkspace(path);
    // clangd: reset availability for the new root, then warm the semantic
    // engine (spawn + background index) — best effort, never blocks the UI.
    resetClangdAvailabilityCache();
    if (path) void window.jellybot?.clangdWarmup?.(path).catch(() => {});
    await this.outline.setWorkspace(path);
    if (gen !== this.wsApplyGen) return; // superseded — panel/editor stay
    this.panel.setWorkspace(path);
    // Tab memory follows the project switch: persist the old set, restore
    // the new project's remembered tabs.
    await this.editorArea.switchWorkspaceTabs(path);
  }

  /**
   * LLDB stack frames may carry paths from the build machine. Prefer that
   * exact path when it still exists; otherwise map its longest trailing path
   * suffix onto the active project/engine source tree. Results are memoized
   * per workspace — the fallback walks the engine tree, far too slow to redo
   * on every call-stack click.
   */
  private async resolveDebugSourcePath(sourcePath: string): Promise<string> {
    const cacheKey = `${this.workspacePath ?? ""}\u0000${sourcePath}`;
    const cached = this.debugSourcePaths.get(cacheKey);
    if (cached) return cached;
    const pending = this.lookupDebugSourcePath(sourcePath);
    this.debugSourcePaths.set(cacheKey, pending);
    return pending;
  }

  private async lookupDebugSourcePath(sourcePath: string): Promise<string> {
    const bridge = window.jellybot;
    if (!bridge) return sourcePath;
    const existing = await bridge.filterExistingFiles([sourcePath]);
    if (existing.length > 0) return existing[0]!;
    const root = this.workspacePath;
    if (!root) return sourcePath;
    // Main can map stable `Engine/Source/...` and project `Source/...` tails
    // directly against the local roots. This is the normal call-stack path:
    // no PDB preload and no full-tree index. It only scans by basename when
    // the adapter did not provide enough directory information.
    if (bridge.resolveDevModeSourcePath) {
      const resolved = await bridge.resolveDevModeSourcePath(root, sourcePath);
      return resolved ?? sourcePath;
    }
    const normalized = sourcePath.replace(/\\/g, "/");
    const fileName = normalized.split("/").pop();
    if (!fileName) return sourcePath;
    const result = await bridge.searchDevModeFiles(root, fileName, {
      codeOnly: true,
      includeEngine: true,
      limit: 100,
      deadlineMs: 5_000,
    });
    if (!result.ok || result.files.length === 0) return sourcePath;
    const sourceParts = normalized.toLowerCase().split("/").filter(Boolean);
    const suffixScore = (candidate: string): number => {
      const parts = candidate.toLowerCase().replace(/\\/g, "/").split("/").filter(Boolean);
      let score = 0;
      while (
        score < sourceParts.length &&
        score < parts.length &&
        sourceParts[sourceParts.length - 1 - score] ===
          parts[parts.length - 1 - score]
      ) {
        score += 1;
      }
      return score;
    };
    return [...result.files].sort(
      (a, b) => suffixScore(b.path) - suffixScore(a.path),
    )[0]!.path;
  }

  // ------------------------------------------------------------ terminal

  /** Status-bar chevron — open the panel on the terminal tab. */
  revealTerminal(): void {
    this.panel.revealTerminal();
  }

  /** Restore that workspace's task, or its pinned New Task draft. */
  private switchWorkspace(wsId: string): void {
    const workspace = this.deps.getWorkspaces().find((item) => item.id === wsId);
    if (!workspace || this.navigation.workspace?.id === wsId) return;
    const taskId = this.navigation.taskForWorkspace(wsId);
    if (taskId) {
      this.deps.onOpenSession(taskId);
    } else {
      this.showNewTask(wsId);
    }
  }

  private syncWatch(path: string | null): void {
    if (this.watchedPath === path) return;
    const bridge = window.jellybot;
    if (this.watchedPath && bridge?.unwatchDevModePath) {
      void bridge.unwatchDevModePath(this.watchedPath);
    }
    this.watchedPath = path;
    if (path && bridge?.watchDevModePath) {
      void bridge.watchDevModePath(path).catch(() => undefined);
    }
  }

  destroy(): void {
    this.unregisterEditorContext?.();
    this.unregisterEditorContext = null;
    this.teardownDrag();
    window.removeEventListener("keydown", this.keydown, true);
    this.syncWatch(null);
    this.unwatchFsEvents?.();
    this.unwatchFsEvents = null;
    this.unwatchVcsChanges?.();
    this.unwatchVcsChanges = null;
    this.navigation.destroy();
    this.chat?.destroy();
    this.chat = null;
    this.newTask?.destroy();
    this.newTask = null;
    this.quickOpen.destroy();
    this.find.destroy();
    this.contextPill.destroy();
    this.statusPill.destroy();
    this.usages.destroy();
    this.outline.destroy();
    this.docOutline.destroy();
    this.debug.destroy();
    this.debugConsole.destroy();
    this.terminal.destroy();
    this.panel.destroy();
    this.editorArea.destroy();
    this.view.root.remove();
  }

  // -------------------------------------------------------------- splitter

  private wireSplitter(): void {
    this.chatWidth = readChatWidth();
    this.view.setChatWidth(this.chatWidth);
    this.view.chatSplitter.setAttribute(
      "aria-valuemin",
      String(MIN_CHAT_WIDTH),
    );
    this.view.chatSplitter.setAttribute(
      "aria-valuemax",
      String(MAX_CHAT_WIDTH),
    );

    this.view.chatSplitter.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.dragging = true;
      this.startX = event.clientX;
      this.startWidth = this.chatWidth;
      this.view.setChatDragging(true);
      this.view.chatSplitter.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", this.onPointerMove);
      window.addEventListener("pointerup", this.onPointerUp);
      window.addEventListener("pointercancel", this.onPointerUp);
    });

    this.view.chatSplitter.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 24 : 8;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.applyWidth(this.chatWidth + step, true);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        this.applyWidth(this.chatWidth - step, true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.applyWidth(DEFAULT_CHAT_WIDTH, true);
      }
    });

    this.view.chatSplitter.addEventListener("dblclick", () => {
      this.applyWidth(DEFAULT_CHAT_WIDTH, true);
    });
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    // Chat sits right of the splitter: dragging left widens it.
    const next = this.startWidth - (event.clientX - this.startX);
    this.applyWidth(next, false);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    try {
      this.view.chatSplitter.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    this.teardownDrag();
    writeChatWidth(this.chatWidth);
  }

  private teardownDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.view.setChatDragging(false);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
  }

  private applyWidth(px: number, persist: boolean): void {
    this.chatWidth = clampChatWidth(px);
    this.view.setChatWidth(this.chatWidth);
    if (persist) writeChatWidth(this.chatWidth);
  }
}
