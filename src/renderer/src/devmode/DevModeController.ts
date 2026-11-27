import { ConversationController } from "../screens/conversation/ConversationController.js";
import { setEditorContextProvider } from "../state/editorContextState.js";
import { PRE_BUILD_TASK_ID } from "../../../shared/devTaskIds.js";
import { ConversationView } from "../screens/conversation/ConversationView.js";
import { NewTaskController } from "../screens/new-task/NewTaskController.js";
import { NewTaskView } from "../screens/new-task/NewTaskView.js";
import type { PendingAttachment } from "../ui/taskComposer/bindComposerAttachments.js";
import { EditorAreaController } from "./EditorAreaController.js";
import type { AgentReadRange } from "./agentFlash.js";
import type { AgentWriteFilePlan } from "../screens/conversation/cards/toolInvocationHelpers.js";
import { DebugController } from "./DebugController.js";
import { LiveCodingController } from "./LiveCodingController.js";
import { DebugConsoleController } from "./DebugConsoleController.js";
import { DebugConsoleView } from "./DebugConsoleView.js";
import { DebugPanelView } from "./DebugPanelView.js";
import {
  loadBreakpoints,
  saveBreakpoints,
  serializeBreakpoints,
  type BreakpointValue,
  type StoredBreakpoint,
} from "./breakpointStore.js";
import { FindWidgetController } from "./FindWidgetController.js";
import {
  computeEditorStatusMode,
  ContextPillController,
} from "./contextPill.js";
import { FindUsagesController, type SemanticReferencesResult } from "./FindUsagesController.js";
import { TS_LANGUAGE_IDS } from "./tsFeatures.js";
import { clangdAvailable, resetClangdAvailabilityCache } from "./clangdFeatures.js";
import { blueprintSymbolFromHover } from "./unrealBlueprintSymbol.js";

function wordAt(text: string, line: number, column: number): string {
  const lineText = text.split(/\r?\n/)[line - 1] ?? "";
  const before = lineText.slice(0, Math.max(0, column - 1));
  const after = lineText.slice(Math.max(0, column - 1));
  const left = /[A-Za-z_0-9]*$/.exec(before)?.[0] ?? "";
  const right = /^[A-Za-z_0-9]*/.exec(after)?.[0] ?? "";
  const word = left + right;
  return /^[A-Za-z_]/.test(word) ? word : "";
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
import { revealBuildDiagnostic } from "./buildDiagnosticNavigation.js";
import { WorkbenchView } from "./WorkbenchView.js";
import { DevModeNavigationController } from "./DevModeNavigationController.js";
import { CollaborativeController } from "./CollaborativeController.js";

export type DevModeSessionOpenOptions = {
  optimisticUserText?: string;
  attachments?: PendingAttachment[];
  workspaceId?: string | null;
};

export type DevModeDeps = {
  getSessionTitle: (sessionId: string) => string | undefined;
  onOpenSession: (
    sessionId: string,
    options?: DevModeSessionOpenOptions,
  ) => void;
  onPullMergeSession?: (sessionId: string, conflicts: string[], repoRoot: string) => void;
  onOpenCocoSettings?: () => void;
  onWorkspaceChanged?: () => void;
  onCreateWorkspace: (anchor: HTMLButtonElement) => void;
  getSessionWorkspacePath: (sessionId: string) => string | null;
  getWorkspaceSessions: (wsId: string) => Array<{
    id: string;
    title: string;
    status?: string;
    updatedAt: number;
  }>;
  onArchiveSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  getActiveWorkspaceId?: () => string | null;
  onNewTask?: (workspaceId: string | null) => void;
  getWorkspaces: () => Array<{ id: string; name: string; path: string }>;
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
  }
}

export class DevModeController {
  private unregisterEditorContext: (() => void) | null = null;
  private readonly view = new WorkbenchView();
  private readonly navigation: DevModeNavigationController;
  private readonly outline: SolutionOutlineController;
  private collaborative: CollaborativeController | null = null;
  private readonly editorArea = new EditorAreaController({
    onActiveTabChanged: (path) => {
      this.collaborative?.onLocalFile(path);
      this.outline.followActiveFile(path);
      this.find.notifyModelChanged();
      void this.docOutline.refresh();
    },
    onReferenceFile: (path, name) => this.insertFileReference(path, name),
    onRevealInTree: (path) => void this.outline.revealPath(path),
    // Editor features (annotate, side-by-side diff, clangd) follow the workspace the file
    // tree shows, not the open session: New Task has no session, and a session's workspace
    // is not resolvable until the session/workspace state has loaded.
    getWorkspaceRoot: () => this.workspacePath ?? this.requestedWorkspacePath ?? null,
    getSessionId: () => this.sessionId,
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
    onDocumentChanged: () => { this.collaborative?.onLocalDocumentChanged(); this.docOutline.scheduleRefresh(); },
    onCursorLineChanged: (line) => this.docOutline.setCursorLine(line),
    onOpenSymbolSearch: (query) => this.quickOpen.open(query),
    onEscape: () => this.find.close(),
    queryFileIndex: (base) => this.quickOpen.filesByBasename(base),
    onFindUsages: () => void this.usages.find(),
  });
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
  private readonly panel = new UnifiedPanelController();
  private readonly debug: DebugController;
  private readonly liveCoding: LiveCodingController;
  private readonly debugConsole: DebugConsoleController;
  private readonly terminal = new TerminalPaneController(
    this.panel.terminalView,
    { openPanel: () => this.panel.revealTerminal(false) },
  );
  private readonly quickOpen: QuickOpenController;
  private readonly find: FindWidgetController;
  private readonly contextPill: ContextPillController;
  private readonly statusPill: ContextPillController;
  private readonly usages: FindUsagesController;
  private chat: ConversationController | null = null;
  private newTask: NewTaskController | null = null;
  private sessionId: string | null = null;
  private workspacePath: string | null = null;
  private editorWorkspacePath: string | null | undefined = null;
  private destroyed = false;
  private wsApplyGen = 0;
  private requestedWorkspacePath: string | null | undefined;
  private readonly debugSourcePaths = new Map<string, Promise<string>>();
  private watchedPath: string | null = null;
  private unwatchFsEvents: (() => void) | null = null;
  private unwatchVcsChanges: (() => void) | null = null;
  private agentOpenChain: Promise<void> = Promise.resolve();
  private chatWidth = DEFAULT_CHAT_WIDTH;
  private dragging = false;
  private startX = 0;
  private startWidth = 0;
  private readonly keydown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return;
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
    this.liveCoding = new LiveCodingController(debugView, {
      revealBuild: (workspacePath) => {
        this.panel.ensureWorkspace(workspacePath);
        this.panel.revealForTask("build");
      },
    });
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
      revealBuild: (workspacePath) => {
        this.panel.ensureWorkspace(workspacePath);
        this.panel.revealForTask("build");
      },
      revealFileLine: (path, line, isCurrent) =>
        this.editorArea.revealFileLine(path, line, undefined, isCurrent ? { isCurrent } : undefined),
      resolveSourcePath: (path) => this.resolveDebugSourcePath(path),
      isWorkspaceReady: () =>
        this.workspacePath === this.requestedWorkspacePath &&
        this.editorWorkspacePath === this.requestedWorkspacePath,
      onSessionLive: (live) => this.panel.setDebugSessionLive(live),
      onSnapshot: snapshot => {
        this.editorArea.setUnrealDebugState(snapshot);
        this.liveCoding.refresh();
      },
      getDebugSourceRoots: () => this.editorArea.getUnrealSourceRoots(),
    });
    this.editorArea.onUnrealChoice = (choice) => {
      this.liveCoding.setChoice(this.workspacePath, choice);
    };
    this.liveCoding.start();
    this.panel.installDebugView(debugView.root);
    this.panel.installDebugConsoleView(debugConsoleView.root);
    const usagesView = new FindUsagesView();
    this.usages = new FindUsagesController(usagesView, {
      getSemanticReferences: async (): Promise<SemanticReferencesResult> => {
        const caret = this.editorArea.getCaretDocument();
        const isTs = !!caret?.languageId && (TS_LANGUAGE_IDS as readonly string[]).includes(caret.languageId);
        if (!caret || (caret.languageId !== "cpp" && !isTs)) return { status: "unsupported" };
        const word = wordAt(caret.text, caret.line, caret.column);
        if (!word) return { status: "no-symbol" };
        const bridge = window.jellybot;
        if (isTs) {
          const server = "The TypeScript language server";
          if (!this.workspacePath || !bridge?.tsLsReferences) return { status: "unavailable", server };
          try {
            const result = await bridge.tsLsReferences(this.workspacePath, {
              path: caret.path,
              line: caret.line,
              column: caret.column,
              text: caret.text,
            });
            if (!result.ok) {
              return result.reason === "not_found"
                ? { status: "unavailable", server }
                : { status: "failed", server, word, message: result.message };
            }
            return { status: "ok", word, references: result.locations };
          } catch (err) {
            return { status: "failed", server, word, message: err instanceof Error ? err.message : String(err) };
          }
        }
        const server = "clangd";
        if (!this.workspacePath || !bridge?.clangdReferences) return { status: "unavailable", server };
        if (!(await clangdAvailable(this.workspacePath))) return { status: "unavailable", server };
        const active = this.editorArea.getActiveDocument();
        try {
          const result = await bridge.clangdReferences(this.workspacePath, {
            path: caret.path,
            line: caret.line,
            column: caret.column,
            text: active && active.path === caret.path ? active.text : caret.text,
          });
          if (!result.ok) {
            return { status: "failed", server, word, message: result.message ?? "request failed" };
          }
          return {
            status: "ok",
            word,
            references: (result.references ?? []).map((ref) => ({
              path: ref.path,
              line: ref.line,
              column: ref.column,
            })),
          };
        } catch (err) {
          return {
            status: "failed",
            server,
            word,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      },
      getBlueprintReferences: async () => {
        const caret = this.editorArea.getCaretDocument();
        const bridge = window.jellybot;
        const root = this.workspacePath;
        if (!caret || caret.languageId !== "cpp" || !root) return { status: "unavailable" };
        if (!bridge?.unrealBlueprintReferences || !bridge.clangdHover) return { status: "unavailable" };
        if (!(await clangdAvailable(root))) return { status: "unavailable" };
        const active = this.editorArea.getActiveDocument();
        const hover = await bridge.clangdHover(root, {
          path: caret.path,
          line: caret.line,
          column: caret.column,
          text: active && active.path === caret.path ? active.text : caret.text,
        });
        const symbol = blueprintSymbolFromHover(hover.ok ? hover.markdown ?? null : null);
        if (!symbol) return { status: "unavailable" };
        return bridge.unrealBlueprintReferences(root, symbol);
      },
      selectBlueprint: async (row) => {
        const bridge = window.jellybot;
        if (!this.workspacePath || !bridge?.selectUnrealBlueprintAsset) {
          return { status: "unavailable" };
        }
        return bridge.selectUnrealBlueprintAsset(this.workspacePath, { assetPath: row.assetPath });
      },
      openBlueprint: async (target) => {
        const bridge = window.jellybot;
        if (!this.workspacePath || !bridge?.openUnrealBlueprintReference) {
          return { ok: false, message: "Unreal Editor is not connected to this project." };
        }
        return bridge.openUnrealBlueprintReference(this.workspacePath, target);
      },
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
      revealFileLine: (path, line, column) =>
        void this.editorArea.revealFileLine(path, line, column),
      revealPanel: () => this.panel.revealReferences(),
    });
    this.panel.onOpenBuildDiagnostic = (item, workspacePath) => {
      void revealBuildDiagnostic(item, workspacePath, {
        getWorkspacePath: () => this.workspacePath,
        filterExistingFiles: (paths) => window.jellybot!.filterExistingFiles(paths),
        resolveSourcePath: async (root, path) =>
          await window.jellybot?.resolveDevModeSourcePath?.(root, path) ?? null,
        revealFileLine: (path, line, column) =>
          this.editorArea.revealFileLine(path, line, column),
      }).catch(() => undefined);
    };
    this.panel.installReferencesView(usagesView.root);
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
      foldable: false,
      doneFade: true,
    });
    this.outline = new SolutionOutlineController({
      onOpenFile: (path) => void this.editorArea.openFile(path),
      onVcsRefreshed: () => this.editorArea.refreshVcsDecorations(),
      onTaskRun: (task) => {
        this.panel.ensureWorkspace(this.workspacePath);
        this.panel.revealForTask(task);
      },
      onDebugAvailable: (available, kind) => {
        this.panel.setDebugAvailable(available, kind);
        this.editorArea.setDebugEnabled(available);
        this.editorArea.setDebugRecipe(kind);
        this.editorArea.setConfigVisible(kind !== "unreal");
      },
      onDeployConfigChange: (command) => {
        this.editorArea.setDeployCommand(command);
        this.panel.ensureWorkspace(this.workspacePath);
        this.panel.setDeployAvailable(command !== null);
      },
      onLintAvailable: (available) => this.editorArea.setLintAvailable(available),
      onTaskStateChange: (task, running, failed) => {
        if (task === "build") this.editorArea.setBuildState(running, failed);
        if (task === PRE_BUILD_TASK_ID) this.editorArea.setLintState(running, failed);
        if (task === "deploy") this.editorArea.setDeployState(running, failed);
      },
      onBuildTitleChange: (title) => this.editorArea.setBuildTitle(title),
      isChatBusy: () => this.chat?.isBusy() ?? false,
      onCommitFile: path => this.collaborative?.openLocalCommit(path) ?? false,
    });
    this.navigation.workspaceActions.prepend(this.outline.refreshButton);
    this.collaborative = new CollaborativeController({
      area: this.editorArea,
      localTree: this.outline.root,
      headerActions: this.navigation.workspaceActions,
      isChatBusy: () => this.chat?.isBusy() ?? false,
    });
    this.editorArea.onBuildClick = () => this.outline.runBuild();
    this.editorArea.onLintClick = () => this.outline.runLint();
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
    const filesCard = document.createElement("div");
    filesCard.className = "devmode-files-card";
    filesCard.append(this.navigation.workspaceHeader, this.outline.root);
    if (this.collaborative) filesCard.append(this.collaborative.tree);
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
    this.panel.mount(this.view.editorPane);
    this.editorArea.mountStatusBar(this.panel.statusHost);
    this.quickOpen.mount(this.view.editorPane);
    this.find.mount(this.view.editorPane);
    this.contextPill.mount(this.view.chatPane);
    this.statusPill.mount(this.view.editorPane);
    this.statusPill.setGate(readChatCollapsed());
    window.addEventListener("keydown", this.keydown, true);
    this.editorArea.appendFab(this.view.chatExpandButton);
    this.panel.terminalControllerStop = () => this.terminal.requestStop();
    this.debug.mount();
    this.debugConsole.mount();
    this.wireSplitter();
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
        this.collaborative?.onLocalFilesChanged(payload.rootPath, payload.events);
        this.editorArea.refreshUnrealFiles(payload.events);
        this.editorArea.handleFsEvent(payload);
      });
    }
    if (bridge?.onVcsChanged) {
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

  showNewTask(fixedWorkspaceId?: string | null): void {
    const workspaces = this.deps.getWorkspaces();
    const requested = fixedWorkspaceId ?? this.navigation.workspace?.id ?? this.deps.getActiveWorkspaceId?.();
    const workspace = workspaces.find((item) => item.id === requested) ?? workspaces[0];
    this.navigation.closeMenus();
    this.chat?.destroy();
    this.chat = null;
    this.newTask?.destroy();
    const view = new NewTaskView();
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

  closeActiveTab(): boolean {
    return this.editorArea.closeActiveTab();
  }

  private insertFileReference(path: string, name: string): void {
    if (this.view.root.classList.contains("is-chat-collapsed")) {
      this.setChatCollapsed(false);
    }
    const chat = this.chat ?? this.newTask;
    if (!chat) {
      this.view.announceFileReference("Open a task to insert a file reference.");
      return;
    }
    const inserted = chat.insertFileReference(path);
    this.view.announceFileReference(inserted
      ? `Inserted file reference for ${name}.`
      : "The prompt field is unavailable.");
  }

  private updateChatTitle(): void {
    const suffix = this.sessionId
      ? (this.deps.getSessionTitle(this.sessionId) ?? "Task")
      : this.newTask
        ? "New Task"
        : "No task";
    this.view.setChatTitle(suffix);
  }

  private setChatCollapsed(collapsed: boolean): void {
    this.view.setChatCollapsed(collapsed);
    this.view.chatExpandButton.classList.toggle("is-in", collapsed);
    this.view.chatExpandButton.setAttribute("aria-hidden", String(!collapsed));
    this.view.chatExpandButton.tabIndex = collapsed ? 0 : -1;
    this.statusPill.setGate(collapsed);
    writeChatCollapsed(collapsed);
  }

  notifySessionsChanged(): void {
    if (this.sessionId) {
      this.updateChatTitle();
      const path = this.deps.getSessionWorkspacePath(this.sessionId);
      if (path) {
        this.navigation.setContext(path, this.sessionId);
        if (path !== this.workspacePath) void this.applyWorkspace(path);
      }
    } else if (this.newTask && !this.navigation.workspace && this.deps.getWorkspaces().length) {
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
        onOpenFile: (path) => void this.openChatFile(path),
        onFileWritten: (files) => this.openAgentWrittenFiles(files),
        onFileRead: (path, range) => this.openAgentReadFile(path, range),
        onToggleDevMode: () => this.deps.onExitDevMode?.(),
        onContextPill: (snapshot) => {
          this.contextPill.update(snapshot);
          this.statusPill.update(snapshot);
        },
        onPillNotice: (text, ms, spinner) => {
          const opts = spinner === true ? { spinner: true } : undefined;
          this.contextPill.showNotice(text, ms, opts);
          this.statusPill.showNotice(text, ms, opts);
        },
      },
    );
    conversation.onPullMergeSession = (conflicts, repoRoot) => {
      this.deps.onPullMergeSession?.(sessionId, conflicts, repoRoot);
    };
    conversation.onOpenCocoSettings = () => {
      this.deps.onOpenCocoSettings?.();
    };
    this.view.chatHost.replaceChildren(conversation.mount());
    this.chat = conversation;
    this.updateChatTitle();
    this.view.setChatHasSession(true);
    void this.applyWorkspace(
      this.resolveSessionWorkspacePath(sessionId, options?.workspaceId),
    );
  }

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

  private openAgentWrittenFiles(files: AgentWriteFilePlan[]): void {
    const root = this.workspacePath;
    for (const file of files) {
      const path = resolveWorkspaceFilePath(file.path, root);
      if (path === null) continue;
      this.agentOpenChain = this.agentOpenChain
        .then(() => {
          if (this.destroyed || this.workspacePath !== root) return;
          return this.editorArea.openAgentFile(path);
        })
        .then(() => {
          if (this.destroyed || this.workspacePath !== root) return;
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

  private openAgentReadFile(rawPath: string, range: AgentReadRange): void {
    const root = this.workspacePath;
    const path = resolveWorkspaceFilePath(rawPath, root);
    if (path === null) return;
    this.agentOpenChain = this.agentOpenChain
      .then(() => {
        if (this.destroyed || this.workspacePath !== root) return;
        return this.editorArea.openAgentFile(path);
      })
      .then(() => {
        if (this.destroyed || this.workspacePath !== root) return;
        this.editorArea.flashLineRanges(path, [
          { start: range.start, end: range.end, kind: "read" },
        ]);
      })
      .catch(() => undefined);
  }

  private async applyWorkspace(path: string | null): Promise<void> {
    if (this.destroyed) return;
    const workspaceChanged = path !== this.requestedWorkspacePath;
    if (workspaceChanged) {
      this.requestedWorkspacePath = path;
      this.wsApplyGen += 1;
    }
    const gen = this.wsApplyGen;
    await this.debug.setWorkspace(path);
    if (this.destroyed || gen !== this.wsApplyGen) return;
    this.syncWatch(path);
    this.terminal.setWorkspace(path);
    if (path === this.workspacePath && (!workspaceChanged || this.editorWorkspacePath === path)) {
      this.panel.ensureWorkspace(path);
      if (workspaceChanged) void this.debug.restoreWorkspaceState();
      return;
    }
    const previousEditorWorkspace = this.editorWorkspacePath;
    this.editorWorkspacePath = undefined;
    this.workspacePath = path;
    void this.editorArea.setUnrealWorkspace(path);
    this.liveCoding.setWorkspace(path);
    resetClangdAvailabilityCache();
    if (path) void window.jellybot?.clangdWarmup?.(path).catch(() => {});
    const collaborative = this.collaborative?.setWorkspace(path);
    await this.outline.setWorkspace(path);
    if (this.destroyed || gen !== this.wsApplyGen) return;
    this.panel.setWorkspace(path);
    const restored = await this.editorArea.switchWorkspaceTabs(path);
    if (this.destroyed || gen !== this.wsApplyGen) return;
    this.editorWorkspacePath = restored ? path : previousEditorWorkspace;
    if (restored) void this.debug.restoreWorkspaceState();
    await collaborative;
  }

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
    const root = this.workspacePath;
    const existing = await bridge.filterExistingFiles([sourcePath]);
    if (existing.length > 0) return existing[0]!;
    if (!root) return sourcePath;
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


  revealTerminal(): void {
    this.panel.revealTerminal();
  }

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

  revealDebugPanel(): void {
    this.panel.revealDebug();
  }

  handleDebugBreakpointRequest(payload: Record<string, unknown>): {
    ok: boolean;
    message?: string;
    data?: {
      breakpoints: StoredBreakpoint[];
      livePushed: boolean;
      paths?: string[];
    };
  } {
    const normPath = (value: string): string =>
      value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const workspacePath =
      typeof payload.workspacePath === "string" ? payload.workspacePath.trim() : "";
    if (!workspacePath) return { ok: false, message: "workspacePath is required" };
    const op = (payload.op ?? {}) as {
      action?: unknown;
      path?: unknown;
      line?: unknown;
      condition?: unknown;
      enabled?: unknown;
    };
    const action = typeof op.action === "string" ? op.action : "list";
    const path = typeof op.path === "string" ? op.path.trim() : "";
    const line = typeof op.line === "number" ? op.line : 0;
    const condition = typeof op.condition === "string" ? op.condition : undefined;
    const enabled = typeof op.enabled === "boolean" ? op.enabled : undefined;
    if (action !== "list" && action !== "clear") {
      if (!path) return { ok: false, message: "path is required" };
      if (!Number.isInteger(line) || line <= 0) {
        return { ok: false, message: "line must be a positive integer" };
      }
    }

    if (normPath(workspacePath) === normPath(this.workspacePath ?? "")) {
      switch (action) {
        case "list":
          break;
        case "add":
          this.debug.addBreakpoint(path, line, {
            ...(condition !== undefined ? { condition } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          });
          break;
        case "remove":
          this.debug.removeBreakpoint(path, line);
          break;
        case "enable":
          this.debug.setBreakpointEnabled(path, line, true);
          break;
        case "disable":
          this.debug.setBreakpointEnabled(path, line, false);
          break;
        case "set_condition":
          this.debug.setBreakpointCondition(path, line, condition ?? "");
          break;
        case "clear":
          this.debug.clearAllBreakpoints();
          break;
        default:
          return { ok: false, message: `Unknown breakpoint action "${action}"` };
      }
      return {
        ok: true,
        data: { breakpoints: this.debug.listBreakpoints(), livePushed: true },
      };
    }

    const store = loadBreakpoints(workspacePath);
    const before = new Set(store.keys());
    const key = path.replace(/\\/g, "/");
    const lines = store.get(key) ?? new Map<number, BreakpointValue>();
    switch (action) {
      case "list":
        break;
      case "add": {
        const previous = lines.get(line);
        lines.set(line, {
          condition: condition?.trim() ?? previous?.condition ?? "",
          enabled: enabled ?? previous?.enabled ?? true,
        });
        store.set(key, lines);
        break;
      }
      case "remove": {
        if (lines.delete(line)) {
          if (lines.size === 0) store.delete(key);
          else store.set(key, lines);
        }
        break;
      }
      case "enable":
      case "disable": {
        const value = lines.get(line);
        if (!value) return { ok: false, message: `No breakpoint at ${key}:${line}` };
        value.enabled = action === "enable";
        store.set(key, lines);
        break;
      }
      case "set_condition": {
        const value = lines.get(line);
        if (!value) return { ok: false, message: `No breakpoint at ${key}:${line}` };
        value.condition = (condition ?? "").trim();
        store.set(key, lines);
        break;
      }
      case "clear":
        store.clear();
        break;
      default:
        return { ok: false, message: `Unknown breakpoint action "${action}"` };
    }
    saveBreakpoints(workspacePath, store);
    return {
      ok: true,
      data: {
        breakpoints: serializeBreakpoints(store),
        livePushed: false,
        paths: [...new Set([...before, ...store.keys()])],
      },
    };
  }

  hasUnsavedDrafts(): boolean { return this.collaborative?.hasUnsavedDrafts() ?? false; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.wsApplyGen += 1;
    this.debugSourcePaths.clear();
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
    this.collaborative?.destroy();
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
    this.liveCoding.dispose();
    this.debug.destroy();
    this.debugConsole.destroy();
    this.terminal.destroy();
    this.panel.destroy();
    this.editorArea.destroy();
    this.view.root.remove();
  }


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
    const next = this.startWidth - (event.clientX - this.startX);
    this.applyWidth(next, false);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    try {
      this.view.chatSplitter.releasePointerCapture(event.pointerId);
    } catch {
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
