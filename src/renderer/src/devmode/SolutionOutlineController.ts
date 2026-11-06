/**
 * Solution Outline — Dev Mode left pane (plan: dev-mode-v1).
 *
 * Workspace with .sln → solution tree (virtual solution folders, nested
 * projects per NestedProjects, Solution Items files). Without .sln → plain
 * lazy folder tree. Project & directory nodes expand lazily via
 * devmode:listDir (bin/obj/.git/… filtered main-side). fs.watch events
 * refresh expanded directories with renderer-side coalescing. The header
 * Refresh button and a folder's context-menu Refresh re-read expanded
 * directories from disk when a watch event was missed.
 */
import {
  buildSlnTree,
  parseSln,
  type SlnTreeNode,
} from "../../../dotnet/slnParser.js";
import { parseMsBuildProject } from "../../../dotnet/msbuildProjectParser.js";
import { buildProjectFileTree, type ProjectFileNode } from "../../../dotnet/projectItemTree.js";
import {
  ChevronRight,
  createLucideIcon,
  ExternalLink,
  FileText,
  FolderFill,
  FolderOpenFill,
  Package,
  PackageOpen,
  RefreshCw,
  Search,
  SquareTerminal,
  X,
} from "../ui/originalIcons.js";
import { createLanguageIcon } from "../ui/languageIcons.js";
import { languageForPath } from "./languages.js";
import { openCommitDialog } from "./CommitDialogController.js";
import { coveringSymbolScanRoot } from "./cppSymbolIndex.js";
import {
  baseNameOf,
  isUeEngineProjectPath,
  parentDirOf,
  resolveSlnRelative,
  ueProjectRootOf,
} from "./slnPaths.js";
import { debugButtonTitle, type DebugRecipe } from "../../../debug/debugCopy.js";

type OutlineKind = "solution" | "folder" | "project" | "dir" | "file";

type OutlineNode = {
  key: string;
  label: string;
  kind: OutlineKind;
  /** Absolute fs path when the node maps to disk (null for virtual only). */
  path: string | null;
  /** Directory listed on expand (project → real project root after UE redirect). */
  listDir: string | null;
  children: OutlineNode[];
  childrenLoaded: boolean;
  expanded: boolean;
  loading?: boolean;
  error?: string;
  /** Project root lives outside the workspace (UE engine modules) — read-only. */
  external?: boolean;
  /** Resolved from the project file's item list (vs. plain dir listing). */
  projectItems?: boolean;
  /** Launchable by double-click (main-side whitelist / exec bit — single source). */
  executable?: boolean;
};

export type SolutionOutlineDeps = {
  /** File row clicked → s7 EditorArea opens a tab. */
  onOpenFile: (path: string) => void;
  /** VCS state refreshed (badges/dots) — editor gutter may need a refresh. */
  onVcsRefreshed?: () => void;
  /** Build started (or re-clicked while running) — focus the output panel. */
  onTaskRun?: (task: string) => void;
  /** Unreal / Electron / web workspaces expose Debug; others disable it. */
  onDebugAvailable?: (
    available: boolean,
    kind: DebugRecipe | null,
  ) => void;
  /** Build run state changed — mirrors the editor launch cluster. */
  onTaskStateChange?: (
    task: string,
    running: boolean,
    failed: boolean,
  ) => void;
  /** Effective deploy command, or null when absent / invalid. */
  onDeployConfigChange?: (command: string | null) => void;
  /** Build button title changed (command / config status). */
  onBuildTitleChange?: (title: string) => void;
  /** Chat pane mid-turn — path-scoped commits must not snapshot a half-written tree. */
  isChatBusy?: () => boolean;
};

const REFRESH_COALESCE_MS = 200;
/**
 * VCS refresh debounce — deliberately generous. Status runs are the one
 * expensive thing here on big working copies (the old "svn changes" trap:
 * never diff, never read contents); fs-event bursts coalesce into a single
 * `status` spawn, plus the main process throttles repeats to 1/s.
 */
const VCS_REFRESH_COALESCE_MS = 600;
/** Badge priority for directory aggregation dots: C > D > M > A > U. */
const BADGE_PRIORITY: Record<string, number> = {
  C: 5,
  D: 4,
  M: 3,
  A: 2,
  U: 1,
};

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Comparison key for an already-normalized path. Windows paths are
 * case-insensitive and a `.sln` rarely agrees with the editor on drive /
 * directory casing, so path math there must fold case.
 */
function pathKey(p: string): string {
  return window.jellybot?.platform === "win32" ? p.toLowerCase() : p;
}

export class SolutionOutlineController {
  readonly root: HTMLElement;

  private readonly bodyEl: HTMLElement;

  private treeNodes: OutlineNode[] = [];
  private workspacePath: string | null = null;
  /** Unreal engine source root for this workspace (null = not a UE tree). */
  private engineRoot: string | null = null;
  /** User-added C++ symbol-index roots (engine dirs, …) for the menu state. */
  private symbolExtraRoots: string[] = [];
  private workspaceLabel = "";
  private loadGeneration = 0;
  private selectedKey: string | null = null;
  private refreshTimer: number | null = null;
  private pendingProjects = false;
  private readonly pendingDirs = new Set<string>();

  // ---- VCS badge state (status-only; see vcsStatus.ts performance note)
  private vcsKind: "git" | "svn" | "none" = "none";
  private vcsByPath = new Map<string, string>();
  /** Ancestor dir of any dirty path → strongest badge under it. */
  private vcsDirtyDirs = new Map<string, string>();
  private vcsTimer: number | null = null;
  private ctxMenu: HTMLElement | null = null;

  // ---- header filter row + task state (build launches from the editor
  // tab bar's launch cluster now; this controller owns the data)
  private readonly actionsEl: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private treeRefreshing = false;
  private readonly filterInput: HTMLInputElement;
  private readonly filterCount: HTMLElement;
  private readonly filterClear: HTMLButtonElement;
  /** task id → command line, from `.larry/tasks.json` or Unreal UBT auto-build. */
  private taskCommands = new Map<string, string>();
  private taskOrigins = new Map<string, "file" | "unreal">();
  private debugSupported = false;
  private debugKind: DebugRecipe | null = null;
  private taskConfigError: string | null = null;
  private runningTasks = new Set<string>();
  private failedTasks = new Set<string>();
  private taskConfigGeneration = 0;
  private taskCfgTimer: number | null = null;
  private unwatchDevTaskExit: (() => void) | null = null;
  private actionPop: HTMLElement | null = null;
  private actionPopCleanup: (() => void) | null = null;
  private svnUpdateBusy = false;
  private actionPopAutoClose: number | null = null;

  // ---- file search (action row swaps to an input, body shows flat results)
  private searchMode = false;
  private searchQuery = "";
  private searchGen = 0;
  private searchTimer: number | null = null;
  private searchFirstResult: string | null = null;
  /** Deferred reveal target — collapsed rows are expanded on a short timer. */
  private pendingReveal: string | null = null;
  private revealTimer: number | null = null;

  constructor(private readonly deps: SolutionOutlineDeps) {
    this.root = document.createElement("div");
    this.root.className = "devmode-outline";

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "devmode-outline-body";

    this.actionsEl = document.createElement("div");
    this.actionsEl.className = "devmode-outline-actions";

    // The header row is a persistent filter box (VS Code outline style) —
    // every launch/git/utility button moved away (editor launch cluster,
    // tree context menu). It is built once: rebuilding would drop focus.
    const wrap = document.createElement("div");
    wrap.className = "devmode-outline-filter";
    const filterIcon = createLucideIcon(Search, { size: 12, strokeWidth: 2 });
    filterIcon.classList.add("devmode-outline-filter-icon");
    this.filterInput = document.createElement("input");
    this.filterInput.type = "text";
    this.filterInput.className = "devmode-outline-filter-input";
    // This box searches the whole workspace's files (searchDevModeFiles),
    // not the outline — copy says so (the symbol filter lives below).
    this.filterInput.placeholder = "Search files…";
    this.filterInput.spellcheck = false;
    this.filterInput.autocomplete = "off";
    this.filterInput.setAttribute("aria-label", "Search files");
    this.filterInput.disabled = true; // until a workspace loads
    this.filterInput.addEventListener("input", () => {
      this.searchQuery = this.filterInput.value;
      const query = this.searchQuery.trim();
      this.filterClear.hidden = !query;
      if (!query) {
        this.clearFilterResults();
        return;
      }
      this.searchMode = true;
      this.scheduleSearch();
    });
    this.filterInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        // Esc clears the query and hands focus back to the workbench.
        event.preventDefault();
        this.resetFilter();
        this.filterInput.blur();
      } else if (event.key === "Enter" && this.searchFirstResult) {
        this.deps.onOpenFile(this.searchFirstResult);
      }
    });
    this.filterCount = document.createElement("span");
    this.filterCount.className = "devmode-outline-filter-count";
    this.filterCount.hidden = true;
    this.filterClear = document.createElement("button");
    this.filterClear.type = "button";
    this.filterClear.className = "devmode-outline-filter-clear";
    this.filterClear.title = "Clear filter";
    this.filterClear.setAttribute("aria-label", "Clear filter");
    this.filterClear.append(createLucideIcon(X, { size: 11, strokeWidth: 2 }));
    this.filterClear.hidden = true;
    this.filterClear.addEventListener("click", () => {
      this.resetFilter();
      this.filterInput.focus();
    });
    wrap.append(
      filterIcon,
      this.filterInput,
      this.filterCount,
      this.filterClear,
    );
    this.refreshButton = document.createElement("button");
    this.refreshButton.type = "button";
    this.refreshButton.className = "devmode-outline-refresh";
    this.refreshButton.title = "Refresh";
    this.refreshButton.setAttribute("aria-label", "Refresh");
    this.refreshButton.disabled = true;
    this.refreshButton.append(
      createLucideIcon(RefreshCw, { size: 13, strokeWidth: 2 }),
    );
    this.refreshButton.addEventListener("click", () => {
      void this.refreshOutline(null);
    });
    this.actionsEl.append(wrap, this.refreshButton);

    // No header row — the workspace name lives in the title bar now.
    this.root.append(this.actionsEl, this.bodyEl);

    // Task runs outlive this controller (main-side state) — exit events
    // update button spinners/pips even when the panel is closed.
    const bridge = window.jellybot;
    if (bridge?.onDevTaskExit) {
      this.unwatchDevTaskExit = bridge.onDevTaskExit((snap) =>
        this.handleDevTaskExit(snap),
      );
    }
  }

  // ------------------------------------------------------------ lifecycle

  destroy(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.vcsTimer !== null) window.clearTimeout(this.vcsTimer);
    if (this.taskCfgTimer !== null) window.clearTimeout(this.taskCfgTimer);
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer);
    this.revealTimer = null;
    this.pendingReveal = null;
    this.unwatchDevTaskExit?.();
    this.unwatchDevTaskExit = null;
    this.closeActionPop();
    this.closeContextMenu();
  }

  async setWorkspace(path: string | null): Promise<void> {
    const gen = ++this.loadGeneration;
    if (this.vcsTimer !== null) window.clearTimeout(this.vcsTimer);
    this.vcsTimer = null;
    this.vcsKind = "none";
    this.vcsByPath = new Map();
    this.vcsDirtyDirs = new Map();
    this.workspacePath = path;
    this.engineRoot = null;
    this.symbolExtraRoots = [];
    this.selectedKey = null;
    this.treeNodes = [];
    this.workspaceLabel = path ? baseNameOf(path) : "";
    this.taskCommands = new Map();
    this.taskOrigins = new Map();
    this.debugKind = null;
    this.setDebugSupported(false);
    this.taskConfigError = null;
    this.runningTasks = new Set();
    this.failedTasks = new Set();
    this.taskConfigGeneration++;
    this.deps.onDeployConfigChange?.(null);
    this.syncTaskState("build");
    this.syncTaskState("deploy");
    this.searchMode = false;
    this.searchQuery = "";
    this.searchFirstResult = null;
    this.searchGen++;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.resetFilter();
    this.treeRefreshing = false;
    this.filterInput.disabled = !path;
    this.syncRefreshButton();
    if (path) {
      void this.refreshTaskConfig();
      void this.refreshRunningTasks();
      void this.refreshSymbolRoots();
    }

    const bridge = window.jellybot;
    if (!path || !bridge) {
      this.showPlaceholder(
        path
          ? "Bridge unavailable."
          : "Open a session to load its project here.",
      );
      return;
    }

    this.showPlaceholder("Loading…");
    try {
      const root = await bridge.listDevModeDir(path);
      if (gen !== this.loadGeneration) return;
      if (!root.ok) {
        this.showPlaceholder(`Could not read workspace — ${root.message}`);
        return;
      }

      const slnFiles = root.entries.filter(
        (e) => e.kind === "file" && e.ext === "sln",
      );
      if (slnFiles.length === 0) {
        // Fallback: plain folder tree rooted at the workspace.
        const rootNode = this.makeDirNode(path, this.workspaceLabel);
        rootNode.expanded = true;
        this.treeNodes = [rootNode];
        this.render();
        await this.loadDirChildren(rootNode, gen);
        this.scheduleVcsRefresh(300);
        return;
      }

      // Resolved once per workspace: the engine project's own root cannot be
      // derived from its path (UBT puts it under the game's Intermediate).
      // A failure here only costs the engine redirect, so never let it throw.
      try {
        const resolved = await bridge.getDevModeEngineRoot?.(path);
        if (gen !== this.loadGeneration) return;
        this.engineRoot = resolved ?? null;
      } catch {
        this.engineRoot = null;
      }

      const solutions: OutlineNode[] = [];
      for (const sln of slnFiles) {
        const text = await bridge.readTextFile(sln.path);
        if (gen !== this.loadGeneration) return;
        if (!text.ok) {
          solutions.push(this.makeErrorNode(sln.name, text.message));
          continue;
        }
        const tree = buildSlnTree(parseSln(text.content));
        solutions.push(this.makeSolutionNode(sln.path, tree));
      }
      this.treeNodes = solutions;
      this.render();
      this.scheduleVcsRefresh(300);
    } catch (err) {
      if (gen !== this.loadGeneration) return;
      this.showPlaceholder(
        `Could not load outline — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ------------------------------------------------------------ fs events

  handleFsEvent(payload: {
    rootPath: string;
    events: Array<{ path: string; kind: string }>;
  }): void {
    if (!this.workspacePath) return;
    if (normalize(payload.rootPath) !== normalize(this.workspacePath)) return;

    let slnChanged = false;
    let tasksCfgChanged = false;
    let projectFileChanged = false;
    for (const event of payload.events) {
      const path = normalize(event.path);
      if (
        path.toLowerCase().endsWith(".sln") &&
        parentDirOf(path) === normalize(this.workspacePath)
      ) {
        slnChanged = true;
      }
      if (path.toLowerCase().endsWith(".larry/tasks.json")) {
        tasksCfgChanged = true;
      }
      const lower = path.toLowerCase();
      if (lower.endsWith(".vcxproj") || lower.endsWith(".csproj")) {
        projectFileChanged = true;
      }
      this.pendingDirs.add(parentDirOf(path));
      if (event.kind !== "change") this.pendingDirs.add(path);
    }
    if (tasksCfgChanged) this.scheduleTaskConfigRefresh();

    if (slnChanged) {
      void this.setWorkspace(this.workspacePath);
      return;
    }
    if (projectFileChanged) {
      this.pendingProjects = true;
    }
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.flushRefresh();
    }, REFRESH_COALESCE_MS);
    this.scheduleVcsRefresh(VCS_REFRESH_COALESCE_MS);
  }

  // ------------------------------------------------------------ vcs state

  /**
   * Main detected VCS metadata activity (commit / branch switch / svn up).
   * The fs watcher ignores .git/.svn, so badges need this explicit nudge.
   */
  handleVcsChanged(): void {
    if (!this.workspacePath) return;
    this.scheduleVcsRefresh(100);
  }

  /** Debounced status refresh — one spawn after the events go quiet. */
  private scheduleVcsRefresh(delayMs: number): void {
    if (!this.workspacePath) return;
    if (this.vcsTimer !== null) window.clearTimeout(this.vcsTimer);
    this.vcsTimer = window.setTimeout(() => {
      this.vcsTimer = null;
      void this.refreshVcs();
    }, delayMs);
  }

  private async refreshVcs(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge || !root) return;
    let result;
    try {
      result = await bridge.getVcsStatus(root);
    } catch {
      return; // keep previous badges — never blank the tree on a hiccup
    }
    if (normalize(root) !== normalize(this.workspacePath ?? "")) return;
    if (!result.ok) return;
    this.vcsKind = result.vcs;
    const byPath = new Map<string, string>();
    const dirtyDirs = new Map<string, string>();
    const rootNorm = normalize(root);
    const bump = (dir: string, badge: string): void => {
      const prev = dirtyDirs.get(dir);
      if (!prev || (BADGE_PRIORITY[badge] ?? 0) > (BADGE_PRIORITY[prev] ?? 0)) {
        dirtyDirs.set(dir, badge);
      }
    };
    for (const entry of result.entries) {
      // Entries arrive as absolute posix paths (main resolves repo-root vs
      // cwd-relative differences between git and svn).
      const abs = normalize(entry.path);
      byPath.set(abs, entry.status);
      let dir = parentDirOf(abs);
      while (dir.startsWith(rootNorm)) {
        bump(dir, entry.status);
        if (dir === rootNorm) break;
        dir = parentDirOf(dir);
      }
    }
    this.vcsByPath = byPath;
    this.vcsDirtyDirs = dirtyDirs;
    this.render();
    this.deps.onVcsRefreshed?.();
  }

  /** badge for a file node (abs path) */
  private fileBadge(node: OutlineNode): string | undefined {
    if (!node.path) return undefined;
    return this.vcsByPath.get(normalize(node.path));
  }

  /** aggregated badge for a directory-ish node */
  private dirBadge(node: OutlineNode): string | undefined {
    const dir = this.dirOfNode(node);
    if (!dir) return undefined;
    return this.vcsDirtyDirs.get(normalize(dir));
  }

  // -------------------------------------------------- tab → outline reveal

  private revealSeq = 0;

  /**
   * Expand the tree down to a file (lazily loading each dir on the way),
   * select it and scroll it into view. Extra calls supersede earlier ones.
   */
  async revealPath(absPath: string): Promise<void> {
    const target = normalize(absPath);
    if (!target) return;
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    // The project tree may still be loading (UE item lists are huge). The
    // row does not exist yet — remember the target and retry once the next
    // render lands, so "open file → tree follows" still works on a fresh
    // workspace instead of silently doing nothing.
    if (!this.workspacePath || this.treeNodes.length === 0) {
      this.pendingReveal = target;
      this.armPendingReveal();
      return;
    }
    this.pendingReveal = null;
    // Filtering replaces the tree with a flat result list — expanding and
    // scrolling rows here would fight the user's own filter. The list is
    // short and already sorted, so there is nothing to scroll to.
    if (this.searchMode) return;
    const gen = this.loadGeneration;
    const seq = ++this.revealSeq;
    const hit = await this.revealSearch(this.treeNodes, target, gen, seq);
    if (gen !== this.loadGeneration || seq !== this.revealSeq) return;
    if (!hit) return;
    this.selectedKey = hit.key;
    this.render();
    const row = this.bodyEl.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(hit.key)}"]`,
    );
    row?.scrollIntoView({
      // Instant jump — the smooth scroll on every file locate read as a
      // tree "refresh" flicker, not guidance.
      behavior: "instant",
      block: "center",
      inline: "nearest",
    });
  }

  /**
   * Retry a reveal that arrived before the tree existed. Bounded: give up
   * after a handful of attempts so a missing file cannot spin forever.
   */
  private armPendingReveal(): void {
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer);
    this.revealTimer = window.setTimeout(() => {
      this.revealTimer = null;
      const target = this.pendingReveal;
      this.pendingReveal = null;
      if (target) void this.revealPath(target);
    }, 400);
  }

  /**
   * Quiet selection sync for non-tab activations (tree click, Quick Open,
   * close cascade): move the highlight only when the row is already visible
   * in the rendered tree — never expand lazy dirs, never scroll.
   */
  syncSelection(absPath: string): void {
    if (!this.workspacePath) return;
    const target = `file:${normalize(absPath)}`;
    const findVisible = (nodes: OutlineNode[]): OutlineNode | null => {
      for (const node of nodes) {
        if (node.key === target) return node;
        // Only already-expanded branches are on screen — skip collapsed ones.
        if (node.expanded && node.childrenLoaded) {
          const hit = findVisible(node.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    const hit = findVisible(this.treeNodes);
    if (!hit || this.selectedKey === hit.key) return;
    this.selectedKey = hit.key;
    this.render();
  }

  /** Directory a dir/project node lists on expand (null for virtual/file). */
  private dirOfNode(node: OutlineNode): string | null {
    if (node.kind === "project") return node.listDir;
    if (node.kind === "dir") return node.listDir ?? node.path;
    if (node.kind === "solution") {
      return node.path ? parentDirOf(node.path) : null;
    }
    return null;
  }
  private async revealSearch(
    nodes: OutlineNode[],
    target: string,
    gen: number,
    seq: number,
  ): Promise<OutlineNode | null> {
    const targetKey = pathKey(target);
    for (const node of nodes) {
      if (gen !== this.loadGeneration || seq !== this.revealSeq) return null;
      if (node.kind === "file") {
        if (node.path && pathKey(normalize(node.path)) === targetKey) return node;
        continue;
      }
      if (node.kind === "folder" || node.kind === "solution") {
        // Virtual sln nodes are always loaded, but a collapsed one keeps the
        // hit off screen — open it on the way back out. UE hangs the game
        // under a `Games` solution folder, so this is the common case.
        const hit = await this.revealSearch(node.children, target, gen, seq);
        if (hit) {
          node.expanded = true;
          return hit;
        }
        continue;
      }
      // dir / project: descend only when the target lives under it. External
      // (engine) projects take part — reveal is how an engine file gets a row.
      const dir = this.dirOfNode(node);
      if (!dir) continue;
      if (!targetKey.startsWith(`${pathKey(normalize(dir))}/`)) continue;
      const wasExpanded = node.expanded;
      node.expanded = true;
      if (!node.childrenLoaded) {
        await this.loadDirChildren(node, gen);
        if (gen !== this.loadGeneration || seq !== this.revealSeq) {
          return null;
        }
      }
      const hit = await this.revealSearch(node.children, target, gen, seq);
      if (hit) return hit;
      // Miss → restore the previous expansion shape.
      node.expanded = wasExpanded;
    }
    return null;
  }

  private flushRefresh(): void {
    // While filtering, the tree shape is not shown — refresh results instead.
    if (this.searchMode) {
      this.scheduleSearch();
      return;
    }
    const dirs = [...this.pendingDirs];
    this.pendingDirs.clear();
    const rebuildProjects = this.pendingProjects;
    this.pendingProjects = false;
    const gen = this.loadGeneration;
    void (async () => {
      if (rebuildProjects) {
        // Project files changed on disk — rebuild project-item trees.
        // reloadDirChildren skips projectItems nodes, so drive it here.
        const projects: OutlineNode[] = [];
        this.walk(this.treeNodes, (node) => {
          if (node.projectItems && node.expanded) projects.push(node);
        });
        for (const node of projects) {
          if (gen !== this.loadGeneration) return;
          await this.reloadProjectItems(node, gen);
        }
      }
      for (const dir of dirs) {
        if (gen !== this.loadGeneration) return;
        await this.refreshDir(dir);
      }
      this.render();
    })();
  }

  /** Re-run buildProjectItemTree for one project node, keeping expansion. */
  private async reloadProjectItems(node: OutlineNode, gen: number): Promise<void> {
    if (!node.path || !node.listDir) return;
    const bridge = window.jellybot;
    if (!bridge) return;
    const wasExpanded = node.expanded;
    const expandedKeys = new Set<string>();
    this.walk(node.children, (n) => {
      if (n.expanded) expandedKeys.add(n.key);
    });
    const built = await this.buildProjectItemTree(node, gen, bridge);
    if (gen !== this.loadGeneration) return;
    if (built) {
      node.children = built;
      node.childrenLoaded = true;
      node.projectItems = true;
      this.walk(node.children, (n) => {
        if (expandedKeys.has(n.key)) n.expanded = true;
      });
    } else {
      // Item list no longer usable — fall back to a dir listing.
      node.children = [];
      node.childrenLoaded = false;
      node.projectItems = false;
      await this.loadDirChildren(node, gen);
    }
    node.expanded = wasExpanded;
  }

  private async refreshDir(dir: string): Promise<void> {
    const targets: OutlineNode[] = [];
    this.walk(this.treeNodes, (node) => {
      if (node.expanded && node.childrenLoaded && node.listDir === dir) {
        targets.push(node);
      }
    });
    for (const node of targets) {
      await this.reloadDirChildren(node);
    }
  }

  /** Re-list one directory, preserving deep expansion state by child key. */
  private async reloadDirChildren(node: OutlineNode): Promise<void> {
    if (!node.listDir) return;
    // Project-item trees only change when the project file itself changes —
    // UE writes Content/ constantly, and re-parsing a multi-MB vcxproj on
    // every watch event would jank the outline.
    if (node.projectItems) return;
    const oldByKey = new Map(node.children.map((c) => [c.key, c]));
    node.children = [];
    node.childrenLoaded = false;
    await this.loadDirChildren(node, this.loadGeneration);
    for (const fresh of node.children) {
      const old = oldByKey.get(fresh.key);
      if (!old) continue;
      fresh.expanded = old.expanded;
      if (old.loading) {
        fresh.loading = true;
      }
      if (old.childrenLoaded) {
        fresh.childrenLoaded = true;
        fresh.children = old.children;
      }
    }
  }

  /**
   * Manual refresh. `scope` null re-reads every expanded branch (header
   * button). A folder / project / solution node re-reads that node even
   * when it is collapsed, then re-lists its expanded descendants.
   */
  private async refreshOutline(scope: OutlineNode | null): Promise<void> {
    if (!this.workspacePath || this.treeRefreshing) return;
    if (this.searchMode && scope === null) {
      this.scheduleSearch();
      this.scheduleVcsRefresh(100);
      return;
    }
    const gen = this.loadGeneration;
    this.treeRefreshing = true;
    this.syncRefreshButton();
    try {
      const roots = scope ? [scope] : this.treeNodes;
      for (const node of roots) {
        if (gen !== this.loadGeneration) return;
        await this.refreshOutlineNode(node, gen, scope !== null);
      }
      if (gen !== this.loadGeneration) return;
      this.render();
      this.scheduleVcsRefresh(100);
    } finally {
      if (gen === this.loadGeneration) {
        this.treeRefreshing = false;
        this.syncRefreshButton();
      }
    }
  }

  private syncRefreshButton(): void {
    const busy = this.treeRefreshing;
    this.refreshButton.disabled = !this.workspacePath || busy;
    this.refreshButton.classList.toggle("is-loading", busy);
    this.refreshButton.setAttribute("aria-busy", busy ? "true" : "false");
  }

  /**
   * `explicit` is the node the user asked to refresh (context menu). Tree-wide
   * refresh only walks branches that are already expanded.
   */
  private async refreshOutlineNode(
    node: OutlineNode,
    gen: number,
    explicit: boolean,
  ): Promise<void> {
    if (gen !== this.loadGeneration || node.kind === "file") return;

    if (node.listDir === null) {
      if (!explicit && node.kind === "folder" && !node.expanded) return;
      for (const child of [...node.children]) {
        if (gen !== this.loadGeneration) return;
        await this.refreshOutlineNode(child, gen, false);
      }
      return;
    }

    if (!explicit && !node.expanded) return;

    if (node.kind === "project" && node.projectItems) {
      const wasExpanded = node.expanded;
      await this.reloadProjectItems(node, gen);
      if (gen !== this.loadGeneration) return;
      node.expanded = wasExpanded;
      if (!wasExpanded) return;
      for (const child of [...node.children]) {
        if (!child.expanded) continue;
        await this.refreshOutlineNode(child, gen, false);
      }
      return;
    }

    await this.reloadDirFromDisk(node, gen);
  }

  /** Re-list one directory, then re-list descendants the user had open. */
  private async reloadDirFromDisk(node: OutlineNode, gen: number): Promise<void> {
    if (!node.listDir || gen !== this.loadGeneration) return;
    const wasExpanded = node.expanded;
    const expandedKeys = new Set<string>();
    this.walk(node.children, (child) => {
      if (child.expanded) expandedKeys.add(child.key);
    });
    node.children = [];
    node.childrenLoaded = false;
    node.loading = false;
    delete node.error;
    await this.loadDirChildren(node, gen);
    if (gen !== this.loadGeneration) return;
    node.expanded = wasExpanded;
    for (const child of node.children) {
      if (gen !== this.loadGeneration) return;
      if (!expandedKeys.has(child.key) || child.kind === "file") continue;
      child.expanded = true;
      await this.refreshOutlineNode(child, gen, false);
    }
  }

  // ------------------------------------------------------------ node make

  private makeSolutionNode(
    slnPath: string,
    roots: SlnTreeNode[],
  ): OutlineNode {
    return {
      key: `sln:${slnPath}`,
      label: baseNameOf(slnPath),
      kind: "solution",
      path: slnPath,
      listDir: null,
      children: roots.map((child) => this.makeSlnChildNode(child, slnPath)),
      childrenLoaded: true,
      expanded: true,
    };
  }

  private makeSlnChildNode(node: SlnTreeNode, slnPath: string): OutlineNode {
    if (node.kind === "folder") {
      const children = node.children.map((child: SlnTreeNode) =>
        this.makeSlnChildNode(child, slnPath),
      );
      for (const file of node.files) {
        children.push(this.makeFileNode(resolveSlnRelative(slnPath, file)));
      }
      return {
        key: `slnfolder:${node.guid}`,
        label: node.name,
        kind: "folder",
        path: null,
        listDir: null,
        children,
        childrenLoaded: true,
        expanded: false,
      };
    }
    // Real project — .sln paths may be URLs for web projects.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(node.project?.path ?? "")) {
      return this.makeErrorNode(node.name, "Web project (no local path)");
    }
    const projectPath = resolveSlnRelative(slnPath, node.project?.path ?? "");
    // UE generates `<root>/Intermediate/ProjectFiles/*.vcxproj` — the real
    // project root (Source/, Config/, Plugins/) is two levels up. Expanding
    // the Intermediate dir itself would show nothing but generated files.
    const ueRoot = ueProjectRootOf(projectPath);
    // The engine's own project sits next to the game's under the game root's
    // Intermediate/, so the two-levels-up rule would list game code under
    // Engine. Its real root only comes from engine detection.
    const engineRoot = isUeEngineProjectPath(projectPath) ? this.engineRoot : null;
    const projectDir =
      engineRoot ?? ueRoot ?? (projectPath ? parentDirOf(projectPath) : null);
    const external =
      !!projectDir &&
      !!this.workspacePath &&
      normalize(projectDir).toLowerCase() !==
        normalize(this.workspacePath).toLowerCase() &&
      !projectDir.toLowerCase().startsWith(
        `${normalize(this.workspacePath).toLowerCase()}/`,
      );
    return {
      key: `project:${node.guid}`,
      label: node.name,
      kind: "project",
      path: projectPath,
      listDir: projectDir,
      children: [],
      childrenLoaded: false,
      expanded: false,
      external,
    };
  }

  private makeDirNode(path: string, label: string): OutlineNode {
    return {
      key: `dir:${normalize(path)}`,
      label,
      kind: "dir",
      path,
      listDir: path,
      children: [],
      childrenLoaded: false,
      expanded: false,
    };
  }

  private makeFileNode(path: string, executable?: boolean): OutlineNode {
    return {
      key: `file:${normalize(path)}`,
      label: baseNameOf(path),
      kind: "file",
      path,
      listDir: null,
      children: [],
      childrenLoaded: true,
      expanded: false,
      ...(executable ? { executable } : {}),
    };
  }

  private makeErrorNode(label: string, message: string): OutlineNode {
    return {
      key: `error:${label}:${message}`,
      label,
      kind: "file",
      path: null,
      listDir: null,
      children: [],
      childrenLoaded: true,
      expanded: false,
      error: message,
    };
  }

  // ----------------------------------------------------------- lazy loads

  private async loadDirChildren(node: OutlineNode, gen: number): Promise<void> {
    if (!node.listDir || node.childrenLoaded) return;
    node.loading = true;
    this.render();
    const bridge = window.jellybot;
    if (!bridge) {
      node.loading = false;
      node.error = "Bridge unavailable";
      node.childrenLoaded = true;
      this.render();
      return;
    }
    try {
      let result = await bridge.listDevModeDir(node.listDir);
      if (gen !== this.loadGeneration) return;

      // Project node → try to build the child tree from the project file's
      // explicit item list (mirrors the VS Solution Explorer). SDK-style
      // projects glob implicitly, so an empty/short list falls through to
      // the directory listing above. Any failure falls back gracefully.
      if (node.kind === "project" && node.path && result.ok) {
        const built = await this.buildProjectItemTree(node, gen, bridge);
        if (gen !== this.loadGeneration) return;
        if (built) {
          node.loading = false;
          node.children = built;
          node.childrenLoaded = true;
          node.projectItems = true;
          this.render();
          return;
        }
      }

      node.loading = false;
      if (result.ok) {
        node.children = result.entries.map((entry) =>
          entry.kind === "dir"
            ? this.makeDirNode(entry.path, entry.name)
            : this.makeFileNode(entry.path, entry.executable),
        );
        node.childrenLoaded = true;
      } else {
        node.error = result.message;
        node.childrenLoaded = true;
      }
    } catch (err) {
      if (gen !== this.loadGeneration) return;
      node.loading = false;
      node.error = err instanceof Error ? err.message : String(err);
      node.childrenLoaded = true;
    }
    this.render();
  }

  /**
   * Parse the project file (.vcxproj/.csproj) and build a virtual tree from
   * its file items. Returns null when the item list can't serve as the tree
   * (missing file, parse failure, SDK-style implicit globs, out-of-workspace
   * targets) — caller falls back to listing the project's directory.
   */
  private async buildProjectItemTree(
    node: OutlineNode,
    gen: number,
    bridge: NonNullable<typeof window.jellybot>,
  ): Promise<OutlineNode[] | null> {
    const projectPath = node.path;
    if (!projectPath) return null;
    const ext = projectPath.toLowerCase().split(".").pop();
    if (ext !== "vcxproj" && ext !== "csproj") return null;

    let text: string | null = null;
    let message: string | null = null;
    try {
      const res = await bridge.readDevModeProjectFile(projectPath);
      if (gen !== this.loadGeneration) return null;
      if (res.ok) text = res.content;
      else message = res.message;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    if (text === null) {
      // Unreadable project file is not fatal — show it as the first child.
      node.error = message ?? "Could not read project file";
      return null;
    }

    const info = parseMsBuildProject(text);
    if (info.sdkStyle) return null; // implicit globs — dir listing is better

    const projectDir = node.listDir ?? parentDirOf(projectPath);
    if (!projectDir) return null;
    const resolved = info.items
      .map((item) => resolveSlnRelative(projectPath, item.include))
      .filter(
        (p) =>
          projectDir !== "" &&
          (p === projectDir || p.startsWith(`${projectDir}/`)),
      );
    if (resolved.length === 0) return null;
    // Different tags (ClCompile + ClInclude) may repeat a path; dedupe keeps
    // the tree free of duplicate rows while preserving document order.
    const seen = new Set<string>();
    const unique = resolved.filter((p) => {
      const key = p.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Nested dir/file tree like the VS Solution Explorer, dirs-first per
    // level. NF-class UE projects list ~9k items — large but still far
    // cheaper than a recursive walk of Source/ + Plugins/.
    const tree = buildProjectFileTree(projectDir, unique);
    return tree && tree.length > 0 ? this.fromProjectFileNodes(tree) : null;
  }

  /** ProjectFileNode[] → OutlineNode[] (dirs lazily listable, files open). */
  private fromProjectFileNodes(nodes: ProjectFileNode[]): OutlineNode[] {
    return nodes.map((n) => {
      if (!n.isDir) {
        return {
          key: `file:${n.path}`,
          label: n.name,
          kind: "file" as const,
          path: n.path,
          listDir: null,
          children: [],
          childrenLoaded: true,
          expanded: false,
        };
      }
      return {
        key: `dir:${n.path}`,
        label: n.name,
        kind: "dir" as const,
        path: n.path,
        listDir: n.path,
        children: this.fromProjectFileNodes(n.children),
        childrenLoaded: true,
        expanded: false,
      };
    });
  }

  private async toggleExpand(node: OutlineNode): Promise<void> {
    if (node.kind === "file") return;
    if (this.treeAnimKeys.has(node.key)) return;
    if (!node.expanded && !node.childrenLoaded) {
      await this.loadDirChildren(node, this.loadGeneration);
    }
    const wasExpanded = node.expanded;
    node.expanded = !node.expanded;
    if (this.motionReduced()) {
      this.render();
      return;
    }
    if (wasExpanded) this.animateCollapse(node);
    else {
      this.render();
      this.animateExpand(node);
    }
  }

  // -------------------------------------------------------- expand animation

  /** Folder keys with a height animation in flight (re-click guard). */
  private treeAnimKeys = new Set<string>();

  private motionReduced(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** The `.devmode-tree-children` wrapper that follows a node's row. */
  private childContainerOf(key: string): HTMLElement | null {
    const row = this.bodyEl.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(key)}"]`,
    );
    const next = row?.nextElementSibling;
    return next instanceof HTMLElement &&
      next.classList.contains("devmode-tree-children")
      ? next
      : null;
  }

  private animateExpand(node: OutlineNode): void {
    const container = this.childContainerOf(node.key);
    if (!container) return;
    const target = container.scrollHeight;
    if (target <= 0) return;
    this.treeAnimKeys.add(node.key);
    container.style.overflow = "hidden";
    container.style.height = "0px";
    void container.offsetHeight; // pin the collapsed start frame
    container.style.transition = "height 170ms ease";
    container.style.height = `${target}px`;
    window.setTimeout(() => {
      container.style.height = "";
      container.style.overflow = "";
      container.style.transition = "";
      this.treeAnimKeys.delete(node.key);
    }, 180);
  }

  private animateCollapse(node: OutlineNode): void {
    const container = this.childContainerOf(node.key);
    if (!container || container.scrollHeight <= 0) {
      this.render();
      return;
    }
    this.treeAnimKeys.add(node.key);
    // Chevron spins immediately — its CSS follows aria-expanded.
    this.bodyEl
      .querySelector(`[data-key="${CSS.escape(node.key)}"]`)
      ?.setAttribute("aria-expanded", "false");
    container.style.overflow = "hidden";
    container.style.height = `${container.scrollHeight}px`;
    void container.offsetHeight; // pin the expanded start frame
    container.style.transition = "height 170ms ease";
    container.style.height = "0px";
    window.setTimeout(() => {
      this.treeAnimKeys.delete(node.key);
      this.render();
    }, 180);
  }

  // -------------------------------------------------------------- render


  private showPlaceholder(text: string): void {
    this.treeNodes = [];
    this.bodyEl.replaceChildren();
    const el = document.createElement("div");
    el.className = "devmode-outline-placeholder";
    el.textContent = text;
    this.bodyEl.replaceChildren(el);
  }

  private walk(nodes: OutlineNode[], cb: (node: OutlineNode) => void): void {
    for (const node of nodes) {
      cb(node);
      this.walk(node.children, cb);
    }
  }

  private render(): void {
    if (this.searchMode) return;
    const scrollTop = this.bodyEl.scrollTop;
    this.bodyEl.replaceChildren();
    for (const node of this.treeNodes) {
      this.bodyEl.append(this.renderBranch(node, 0));
    }
    this.bodyEl.scrollTop = scrollTop;
  }

  private renderBranch(node: OutlineNode, depth: number): HTMLElement {
    const branch = document.createElement("div");
    branch.className = "devmode-tree-branch";

    const row = document.createElement("div");
    row.className = "devmode-tree-row";
    row.style.setProperty("--depth", String(depth));
    row.dataset.kind = node.kind;
    row.dataset.key = node.key;
    if (node.error) row.title = `${node.label} — ${node.error}`;
    else if (node.path) row.title = node.path;
    if (node.key === this.selectedKey) row.classList.add("is-selected");

    const tw = document.createElement("div");
    tw.className = "devmode-tree-tw";
    const expandable =
      node.kind !== "file" &&
      (node.childrenLoaded ? node.children.length > 0 : true);
    if (expandable) {
      const chevron = createLucideIcon(ChevronRight, {
        size: 12,
        strokeWidth: 1.75,
      });
      tw.append(chevron);
      row.classList.add("is-branch");
      row.setAttribute("aria-expanded", node.expanded ? "true" : "false");
    }

    const icon = document.createElement("span");
    icon.className = "devmode-tree-icon";
    icon.append(this.iconFor(node));

    const label = document.createElement("span");
    label.className = "devmode-tree-label";
    label.textContent = node.label;

    row.append(tw, icon, label);

    if (this.isRunnableFile(node)) {
      row.classList.add("is-runnable");
      row.title = "Double-click to run";
    }

    if (node.external) {
      const ext = document.createElement("span");
      ext.className = "devmode-tree-external";
      ext.textContent = "external";
      ext.title =
        "Project lives outside the workspace — browsable, but saving is blocked";
      row.append(ext);
    }

    // VCS badges: letter chip on files, aggregate dot on directories.
    if (node.kind === "file") {
      const badge = this.fileBadge(node);
      if (badge) {
        const chip = document.createElement("span");
        chip.className = `devmode-tree-st devmode-st-${badge.toLowerCase()}`;
        chip.textContent = badge;
        row.append(chip);
        if (badge === "D") row.classList.add("is-vcs-deleted");
      }
    } else if (
      node.kind === "dir" ||
      node.kind === "project" ||
      node.kind === "solution"
    ) {
      const badge = this.dirBadge(node);
      if (badge) {
        const dot = document.createElement("span");
        dot.className = `devmode-tree-dot devmode-st-${badge.toLowerCase()}`;
        dot.title = "Contains version-control changes";
        row.append(dot);
      }
    }

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openContextMenu(event, node, row);
    });
    row.addEventListener("click", () => {
      if (node.kind === "file") {
        this.selectedKey = node.key;
        // Executables are run, not read: single click only selects (the
        // editor would reject the binary anyway); Open in Editor stays in
        // the context menu.
        if (node.path && !node.error && !node.executable) {
          this.deps.onOpenFile(node.path);
        }
        this.render();
        return;
      }
      void this.toggleExpand(node);
    });
    row.addEventListener("dblclick", () => {
      if (!this.isRunnableFile(node)) return;
      void this.runExecutable(node);
    });

    branch.append(row);

    if (node.expanded) {
      const container = document.createElement("div");
      container.className = "devmode-tree-children";
      if (node.loading) {
        const loading = document.createElement("div");
        loading.className = "devmode-tree-row devmode-tree-loading";
        loading.style.setProperty("--depth", String(depth + 1));
        loading.textContent = "Loading…";
        container.append(loading);
      } else {
        for (const child of node.children) {
          container.append(this.renderBranch(child, depth + 1));
        }
      }
      branch.append(container);
    }
    return branch;
  }

  /** Tree-executable: double-click launches it instead of opening a tab. */
  private isRunnableFile(node: OutlineNode): boolean {
    return (
      node.kind === "file" &&
      !!node.path &&
      !node.error &&
      node.executable === true
    );
  }

  private async runExecutable(node: OutlineNode): Promise<void> {
    const bridge = window.jellybot;
    const path = node.path;
    if (!bridge || !path) return;
    let result: { ok: boolean; message?: string };
    try {
      result = await bridge.runDevModeExecutable(path);
    } catch (err) {
      result = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (!result.ok) {
      await bridge.alertDialog?.({
        title: "Run executable",
        message: `Could not run "${node.label}" — ${result.message ?? "unknown error"}`,
        type: "warning",
      });
    }
  }

  private iconFor(node: OutlineNode): Element {
    switch (node.kind) {
      case "solution":
        return createLucideIcon(PackageOpen, { size: 14 });
      case "project":
        return createLucideIcon(
          node.external ? ExternalLink : Package,
          { size: 14 },
        );
      case "dir":
        return createLucideIcon(node.expanded ? FolderOpenFill : FolderFill, {
          size: 14,
        });
      case "folder":
        return createLucideIcon(FolderFill, { size: 14 });
      default: {
        if (node.executable) {
          return createLucideIcon(SquareTerminal, { size: 14 });
        }
        // Recognizable code file → the same language badge the editor
        // tabs use; everything else keeps the quiet FileText glyph.
        const langKey = languageForPath(node.path ?? node.label).icon;
        return langKey === "text"
          ? createLucideIcon(FileText, { size: 14 })
          : createLanguageIcon(langKey, createLucideIcon);
      }
    }
  }

  // ------------------------------------------------ task action buttons

  /** Debounced `.larry/tasks.json` reload (editor / agent writes it). */
  private scheduleTaskConfigRefresh(): void {
    if (this.taskCfgTimer !== null) window.clearTimeout(this.taskCfgTimer);
    this.taskCfgTimer = window.setTimeout(() => {
      this.taskCfgTimer = null;
      void this.refreshTaskConfig();
    }, 300);
  }

  private async refreshTaskConfig(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge || !root) return;
    const generation = ++this.taskConfigGeneration;
    try {
      const res = await bridge.getDevTaskConfig(root);
      if (root !== this.workspacePath || generation !== this.taskConfigGeneration) return;
      if (res.ok) {
        this.taskCommands = new Map(res.tasks.map((t) => [t.id, t.command]));
        this.taskOrigins = new Map(
          res.tasks
            .filter((t) => t.origin)
            .map((t) => [t.id, t.origin as "file" | "unreal"]),
        );
        this.taskConfigError = res.unrealError ?? null;
        this.debugKind = res.debugKind ?? null;
        this.setDebugSupported(Boolean(res.debugSupported));
      } else {
        this.taskCommands.clear();
        this.taskOrigins.clear();
        this.taskConfigError = res.message;
        this.debugKind = null;
        this.setDebugSupported(false);
      }
    } catch {
      return; // keep previous state — never blank on a hiccup
    }
    this.syncBuildTitle();
    this.deps.onDeployConfigChange?.(this.taskCommands.get("deploy") ?? null);
  }

  private setDebugSupported(available: boolean): void {
    this.debugSupported = available;
    this.deps.onDebugAvailable?.(available, this.debugKind);
  }

  // ---------------------------------------------------- C++ symbol roots

  /** Extra scan roots (engine dirs, …) for the folder context-menu state. */
  private async refreshSymbolRoots(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge?.getCppSymbolExtraRoots || !root) return;
    try {
      const res = await bridge.getCppSymbolExtraRoots(root);
      if (root !== this.workspacePath) return; // workspace switched mid-load
      this.symbolExtraRoots = res.ok ? res.extraRoots : [];
    } catch {
      return; // menu falls back to "add" — main-side validation still guards
    }
  }

  private async addSymbolRoot(dir: string): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge?.addCppSymbolExtraRoot || !root) return;
    try {
      const res = await bridge.addCppSymbolExtraRoot(root, dir);
      if (root !== this.workspacePath) return;
      if (res.ok) {
        this.symbolExtraRoots = res.extraRoots;
        if (res.message) window.alert(res.message);
        return;
      }
      window.alert(`Add to symbol index failed — ${res.message}`);
    } catch (err) {
      window.alert(
        `Add to symbol index failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async removeSymbolRoot(coveringRoot: string): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge?.removeCppSymbolExtraRoot || !root) return;
    try {
      const res = await bridge.removeCppSymbolExtraRoot(root, coveringRoot);
      if (root !== this.workspacePath) return;
      if (res.ok) {
        this.symbolExtraRoots = res.extraRoots;
        return;
      }
      window.alert(`Remove from symbol index failed — ${res.message}`);
    } catch (err) {
      window.alert(
        `Remove from symbol index failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Re-Mark tasks still running in main (Dev Mode re-entry). */
  private async refreshRunningTasks(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge || !root) return;
    try {
      const state = await bridge.getDevTaskState(root);
      if (root !== this.workspacePath) return;
      this.runningTasks = new Set(state.active.map((r) => r.task));
    } catch {
      return;
    }
    this.syncTaskState("build");
    this.syncTaskState("deploy");
  }

  private handleDevTaskExit(snap: {
    task: string;
    workspacePath: string;
    status: string;
  }): void {
    if (!this.workspacePath) return;
    if (normalize(snap.workspacePath) !== normalize(this.workspacePath)) return;
    this.runningTasks.delete(snap.task);
    const failed =
      snap.status === "failed" ||
      snap.status === "timeout" ||
      snap.status === "spawn-error";
    if (failed) this.failedTasks.add(snap.task);
    else this.failedTasks.delete(snap.task);
    this.syncTaskState(snap.task);
  }

  /** Push build run state to the launch cluster (editor tab bar). */
  private syncTaskState(task: string): void {
    this.deps.onTaskStateChange?.(
      task,
      this.runningTasks.has(task),
      this.failedTasks.has(task),
    );
  }

  /** Esc / × / workspace switch — empty the box and restore the tree. */
  private resetFilter(): void {
    this.searchMode = false;
    this.searchQuery = "";
    this.searchFirstResult = null;
    this.searchGen++;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.filterInput.value = "";
    this.filterCount.hidden = true;
    this.filterClear.hidden = true;
    this.render();
  }

  /** Query emptied mid-typing — drop results, keep focus in the box. */
  private clearFilterResults(): void {
    this.searchMode = false;
    this.searchFirstResult = null;
    this.searchGen++;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.filterCount.hidden = true;
    this.filterClear.hidden = true;
    this.render();
  }

  private scheduleSearch(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.runSearch();
    }, 200);
  }

  private async runSearch(): Promise<void> {
    if (!this.searchMode) return;
    const query = this.searchQuery.trim();
    const ws = this.workspacePath;
    if (!query || !ws) {
      this.searchFirstResult = null;
      this.showSearchMeta("Type to filter by name — Enter opens the first match.");
      return;
    }
    const gen = ++this.searchGen;
    this.showSearchMeta("Searching…");
    const bridge = window.jellybot;
    const res = bridge ? await bridge.searchDevModeFiles(ws, query) : null;
    if (!this.searchMode || gen !== this.searchGen) return;
    if (!res) {
      this.showSearchMeta("Search unavailable.");
      return;
    }
    if (!res.ok) {
      this.showSearchMeta(res.message);
      return;
    }
    this.renderSearchResults(res.files, res.truncated);
  }

  private renderSearchResults(
    files: Array<{ path: string; rel: string }>,
    truncated: boolean,
  ): void {
    this.searchFirstResult = files[0]?.path ?? null;
    // Mirror the count into the persistent filter box (short form).
    this.filterCount.textContent = truncated
      ? `${files.length}+`
      : `${files.length}`;
    this.filterCount.hidden = false;
    this.bodyEl.replaceChildren();
    if (files.length === 0) {
      this.showSearchMeta("No matching files.");
      return;
    }
    const meta = document.createElement("div");
    meta.className = "devmode-search-meta";
    meta.textContent = truncated
      ? `${files.length}+ matches — refine the query to narrow`
      : `${files.length} ${files.length === 1 ? "match" : "matches"}`;
    const list = document.createElement("div");
    list.className = "devmode-search-list";
    for (const file of files) {
      const row = document.createElement("div");
      row.className = "devmode-search-item";
      row.title = file.rel;
      const icon = document.createElement("span");
      icon.className = "devmode-tree-icon";
      icon.append(createLucideIcon(FileText, { size: 13, strokeWidth: 1.75 }));
      const name = document.createElement("span");
      name.className = "devmode-search-name";
      name.append(this.highlightName(file.rel.split("/").pop() ?? file.rel));
      const dir = document.createElement("span");
      dir.className = "devmode-search-dir";
      dir.textContent = file.rel.includes("/")
        ? file.rel.slice(0, file.rel.lastIndexOf("/"))
        : "";
      row.append(icon, name, dir);
      row.addEventListener("click", () => {
        for (const other of list.querySelectorAll(".is-selected")) {
          other.classList.remove("is-selected");
        }
        row.classList.add("is-selected");
        this.deps.onOpenFile(file.path);
      });
      list.append(row);
    }
    this.bodyEl.append(meta, list);
  }

  /** Wrap the first case-insensitive query hit in an accent <mark>. */
  private highlightName(name: string): DocumentFragment {
    const query = this.searchQuery.trim();
    const frag = document.createDocumentFragment();
    if (!query) {
      frag.append(name);
      return frag;
    }
    const idx = name.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) {
      frag.append(name);
      return frag;
    }
    const mark = document.createElement("mark");
    mark.className = "devmode-filter-hit";
    mark.textContent = name.slice(idx, idx + query.length);
    frag.append(name.slice(0, idx), mark, name.slice(idx + query.length));
    return frag;
  }

  private showSearchMeta(text: string): void {
    this.searchFirstResult = null;
    const meta = document.createElement("div");
    meta.className = "devmode-search-meta";
    meta.textContent = text;
    this.bodyEl.replaceChildren(meta);
  }

  /** Build title for the launch cluster (command / config status). */
  private syncBuildTitle(): void {
    const command = this.taskCommands.get("build") ?? null;
    const origin = this.taskOrigins.get("build");
    let title: string;
    if (this.taskConfigError && !command) {
      title = `Build — ${this.taskConfigError}`;
    } else if (command && origin === "unreal") {
      title = `Build — UBT (auto) ${command}`;
    } else if (this.taskConfigError) {
      title = `Build — ${this.taskConfigError}`;
    } else {
      title = command
        ? `Build — ${command}`
        : "Build — not configured (click to create .larry/tasks.json)";
    }
    this.deps.onBuildTitleChange?.(title);
  }

  /** Launch the build task — wired to the editor's Build button. */
  runBuild(): void {
    void this.runTask("build");
  }

  runDeploy(): void {
    void this.runTask("deploy");
  }

  private async runTask(task: string): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge || !root) return;
    if (!this.taskCommands.has(task)) {
      await this.openTaskConfig();
      return;
    }
    if (this.runningTasks.has(task)) {
      this.deps.onTaskRun?.(task); // focus the output panel
      return;
    }
    this.failedTasks.delete(task);
    this.runningTasks.add(task);
    this.syncTaskState(task);
    this.deps.onTaskRun?.(task);
    const generation = this.loadGeneration;
    try {
      const res = await bridge.runDevTask(root, task);
      if (root !== this.workspacePath || generation !== this.loadGeneration) return;
      if (!res.ok && !res.runId) {
        this.runningTasks.delete(task);
        this.syncTaskState(task);
        window.alert(`${task} failed to start — ${res.message}`);
      }
    } catch (err) {
      if (root !== this.workspacePath || generation !== this.loadGeneration) return;
      this.runningTasks.delete(task);
      this.syncTaskState(task);
      window.alert(
        `${task} failed to start — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Terminal state arrives via onDevTaskExit.
  }

  /** Open the task config in the editor (skeleton created on first use). */
  /** Open the task config in the editor (skeleton created on first use). */
  async openTaskConfig(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge || !root) return;
    const cfgPath = `${normalize(root)}/.larry/tasks.json`;
    const existing = await bridge.readTextFile(cfgPath);
    if (!existing.ok) {
      const created = await bridge.writeTextFile(
        cfgPath,
        '{\n  "version": 1,\n  "tasks": {}\n}\n',
        false,
      );
      if (!created.ok) {
        window.alert(`Could not create ${cfgPath} — ${created.message}`);
        return;
      }
      void this.refreshTaskConfig();
    }
    this.deps.onOpenFile(cfgPath);
  }

  // ------------------------------------------------------------ popovers

  /** Fixed popover anchored under a button (ctx-menu visuals, form content). */
  private openActionPop(
    anchor: HTMLElement,
    build: (pop: HTMLElement) => void,
  ): void {
    this.closeActionPop();
    const pop = document.createElement("div");
    pop.className = "devmode-action-pop";
    build(pop);
    document.body.append(pop);
    const rect = pop.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(ar.left, window.innerWidth - rect.width - 8))}px`;
    pop.style.top = `${Math.max(8, Math.min(ar.bottom + 8, window.innerHeight - rect.height - 8))}px`;
    this.actionPop = pop;
    const onDown = (e: PointerEvent): void => {
      if (!pop.contains(e.target as Node)) this.closeActionPop();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") this.closeActionPop();
    };
    pop.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    this.actionPopCleanup = () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }

  private closeActionPop(): void {
    this.clearActionPopAutoClose();
    this.actionPopCleanup?.();
    this.actionPopCleanup = null;
    this.actionPop?.remove();
    this.actionPop = null;
  }

  private scheduleActionPopClose(delayMs: number): void {
    this.clearActionPopAutoClose();
    this.actionPopAutoClose = window.setTimeout(() => {
      this.actionPopAutoClose = null;
      this.closeActionPop();
    }, delayMs);
  }

  private clearActionPopAutoClose(): void {
    if (this.actionPopAutoClose !== null) {
      window.clearTimeout(this.actionPopAutoClose);
      this.actionPopAutoClose = null;
    }
  }


  // --------------------------------------------------------- context menu

  private isWindows(): boolean {
    return window.jellybot?.platform === "win32";
  }

  private relativeToWorkspace(abs: string): string {
    const root = this.workspacePath ? normalize(this.workspacePath) : "";
    const p = normalize(abs);
    if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
    if (root && p === root) return "";
    return p;
  }

  /** Workspace-relative dirty paths under a directory (menu-time only). */
  private dirtyPathsUnder(dirAbs: string): string[] {
    const prefix = `${normalize(dirAbs)}/`;
    const paths: string[] = [];
    for (const abs of this.vcsByPath.keys()) {
      if (abs.startsWith(prefix)) paths.push(this.relativeToWorkspace(abs));
    }
    return paths;
  }

  private async runVcs(
    action: Parameters<NonNullable<Window["jellybot"]>["runVcsAction"]>[1],
    verb: string,
  ): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge || !root) return;
    try {
      const result = await bridge.runVcsAction(root, action);
      if (!result.ok) {
        window.alert(`${verb} failed — ${result.message ?? "unknown error"}`);
        return;
      }
    } catch (err) {
      window.alert(
        `${verb} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.scheduleVcsRefresh(100);
  }

  /**
   * Commit dialog for the selected paths: the user writes the message (or has
   * the model draft it), then the commit is scoped to exactly these paths.
   */
  private async commitPaths(paths: string[], title: string): Promise<void> {
    const root = this.workspacePath;
    if (!root || paths.length === 0) return;
    // Same guard as the toolbar Commit: committing mid-turn snapshots a
    // half-finished working tree while the agent is still writing files.
    if (this.deps.isChatBusy?.()) {
      void window.jellybot?.alertDialog?.({
        title: "Commit",
        message: "Wait for the current turn to finish before committing.",
        type: "warning",
      });
      return;
    }
    const result = await openCommitDialog({
      workspacePath: root,
      paths,
      title,
    });
    if (result.committed) this.scheduleVcsRefresh(100);
  }

  /**
   * `svn update` on one path, with the outcome shown in the action popover
   * (revision, touched paths, conflicts). Conflicts keep the popover open —
   * they need the user's attention, not a 2-second toast.
   */
  private async runSvnUpdate(
    anchor: HTMLElement,
    targets: string[],
    label: string,
  ): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge || !root || this.svnUpdateBusy) return;
    this.svnUpdateBusy = true;
    this.openActionPop(anchor, (pop) => {
      const title = document.createElement("div");
      title.className = "devmode-action-pop-title";
      title.textContent = `Update — ${label}`;

      const stats = document.createElement("div");
      stats.className = "devmode-action-pop-stats";
      stats.textContent = "Updating…";

      const msg = document.createElement("div");
      msg.className = "devmode-action-pop-msg";

      const actions = document.createElement("div");
      actions.className = "devmode-action-pop-actions";
      pop.append(title, stats, msg, actions);

      const addClose = (): void => {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "devmode-btn-ghost";
        close.textContent = "Close";
        close.addEventListener("click", () => this.closeActionPop());
        actions.append(close);
      };

      void (async () => {
        try {
          const result = await bridge.runVcsAction(root, {
            kind: "svn-update",
            paths: targets,
          });
          if (!result.ok) throw new Error(result.message ?? "unknown error");
          const summary = result.message ?? "Update finished";
          stats.textContent = summary;
          this.scheduleVcsRefresh(100);
          if (/conflict/i.test(summary)) {
            stats.classList.add("is-warn");
            addClose();
          } else {
            stats.classList.add("is-ok");
            this.scheduleActionPopClose(2500);
          }
        } catch (err) {
          stats.textContent = "Update failed";
          msg.textContent = err instanceof Error ? err.message : String(err);
          addClose();
        } finally {
          this.svnUpdateBusy = false;
        }
      })();
    });
  }

  private confirmDestructive(verb: string, label: string): boolean {
    return window.confirm(
      `${verb} "${label}"? Uncommitted changes will be lost. This cannot be undone.`,
    );
  }

  private menuItem(
    label: string,
    run: () => void,
    opts?: { danger?: boolean; primary?: boolean; disabled?: boolean; hint?: string },
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "devmode-ctx-item";
    if (opts?.danger) btn.classList.add("is-danger", "action-danger", "action-danger-list");
    else if (opts?.primary) btn.classList.add("action-primary");
    btn.append(document.createTextNode(label));
    if (opts?.hint) {
      const hint = document.createElement("span");
      hint.className = "devmode-ctx-hint";
      hint.textContent = opts.hint;
      btn.append(hint);
    }
    if (opts?.disabled) btn.disabled = true;
    btn.addEventListener("click", () => {
      this.closeContextMenu();
      run();
    });
    return btn;
  }

  private menuSep(): HTMLElement {
    const el = document.createElement("div");
    el.className = "devmode-ctx-sep";
    return el;
  }

  private menuLabel(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "devmode-ctx-label";
    el.textContent = text;
    return el;
  }

  private openContextMenu(
    event: MouseEvent,
    node: OutlineNode,
    row: HTMLElement,
  ): void {
    this.closeContextMenu();
    const bridge = window.jellybot;
    if (!bridge) return;
    const menu = document.createElement("div");
    menu.className = "devmode-ctx-menu";
    const abs = node.path;
    const isFile = node.kind === "file";
    const badge = isFile ? this.fileBadge(node) : this.dirBadge(node);
    const rel = abs ? this.relativeToWorkspace(abs) : "";

    if (!isFile) {
      menu.append(
        this.menuItem("Refresh", () => {
          void this.refreshOutline(node);
        }),
        this.menuSep(),
      );
    }

    if (abs && !node.error) {
      menu.append(
        this.menuItem(
          this.isWindows() ? "Show in Explorer" : "Reveal in Finder",
          () => {
            void bridge.revealPath(abs);
          },
        ),
      );
    }
    if (isFile && abs && !node.error) {
      if (this.isRunnableFile(node)) {
        menu.append(
          this.menuItem("Run", () => {
            void this.runExecutable(node);
          }, { primary: true }),
        );
      }
      menu.append(
        this.menuItem("Open in Editor", () => {
          this.deps.onOpenFile(abs);
        }),
      );
    }
    if (abs) {
      menu.append(
        this.menuItem("Copy Path", () => {
          void navigator.clipboard.writeText(abs);
        }),
      );
      if (rel) {
        menu.append(
          this.menuItem("Copy Relative Path", () => {
            void navigator.clipboard.writeText(rel);
          }),
        );
      }
    }

    // --- VCS section (only when a repo was detected and something is dirty)
    const dirForOps =
      node.kind === "project" ? (node.listDir ?? abs) : abs;
    if (this.vcsKind === "git" && bridge) {
      const group: HTMLButtonElement[] = [];
      if (isFile && rel && badge) {
        group.push(
          this.menuItem("Commit…", () => {
            void this.commitPaths([rel], `Commit "${node.label}"`);
          }),
        );
        if (badge === "A") {
          group.push(
            this.menuItem("Unstage Changes", () => {
              void this.runVcs(
                { kind: "git-unstage", paths: [rel] },
                "Unstage",
              );
            }),
          );
        } else {
          group.push(
            this.menuItem("Stage Changes", () => {
              void this.runVcs({ kind: "git-stage", paths: [rel] }, "Stage");
            }),
          );
        }
        if (badge === "D") {
          group.push(
            this.menuItem(
              "Restore Deleted…",
              () => {
                if (this.confirmDestructive("Restore", node.label)) {
                  void this.runVcs(
                    { kind: "git-discard", paths: [rel] },
                    "Restore",
                  );
                }
              },
              { danger: true },
            ),
          );
        } else if (badge !== "U") {
          // Untracked discard = deleting a file → not offered (project rule).
          group.push(
            this.menuItem(
              "Discard Changes…",
              () => {
                if (this.confirmDestructive("Discard", node.label)) {
                  void this.runVcs(
                    { kind: "git-discard", paths: [rel] },
                    "Discard",
                  );
                }
              },
              { danger: true },
            ),
          );
        }
      } else if (!isFile && dirForOps && badge) {
        const dirty = this.dirtyPathsUnder(dirForOps);
        if (dirty.length > 0) {
          group.push(
            this.menuItem(`Commit ${dirty.length} Change(s)…`, () => {
              void this.commitPaths(dirty, `Commit "${node.label}"`);
            }),
          );
          group.push(
            this.menuItem(`Stage ${dirty.length} Change(s)`, () => {
              void this.runVcs(
                { kind: "git-stage", paths: dirty },
                "Stage",
              );
            }),
          );
          const staged = dirty.filter((p) => {
            for (const [absPath, st] of this.vcsByPath) {
              if (this.relativeToWorkspace(absPath) === p) return st === "A";
            }
            return false;
          });
          if (staged.length > 0) {
            group.push(
              this.menuItem(`Unstage ${staged.length} Change(s)`, () => {
                void this.runVcs(
                  { kind: "git-unstage", paths: staged },
                  "Unstage",
                );
              }),
            );
          }
        }
      }
      if (group.length > 0) {
        menu.append(this.menuSep(), this.menuLabel("Git"));
        menu.append(...group);
      }
    } else if (this.vcsKind === "svn" && bridge) {
      const group: HTMLButtonElement[] = [];
      if (dirForOps) {
        const target =
          (isFile && rel ? rel : this.relativeToWorkspace(dirForOps)) || ".";
        group.push(
          this.menuItem(
            target === "." ? "Update Workspace" : `Update "${node.label}"`,
            () => {
              void this.runSvnUpdate(row, [target], node.label);
            },
          ),
        );
      }
      if (badge) {
        const targets = isFile && rel ? [rel] : this.dirtyPathsUnder(dirForOps ?? "");
        if (targets.length > 0) {
          group.push(
            this.menuItem(
              isFile ? "Commit…" : `Commit ${targets.length} Change(s)…`,
              () => {
                void this.commitPaths(targets, `Commit "${node.label}"`);
              },
            ),
          );
          group.push(
            this.menuItem(
              isFile ? "SVN Revert…" : `SVN Revert ${targets.length} Change(s)…`,
              () => {
                if (this.confirmDestructive("Revert", node.label)) {
                  void this.runVcs(
                    { kind: "svn-revert", paths: targets },
                    "SVN revert",
                  );
                }
              },
              { danger: true },
            ),
          );
        }
      }
      if (group.length > 0) {
        menu.append(this.menuSep(), this.menuLabel("SVN"));
        menu.append(...group);
      }
    }

    // --- C++ symbol index section (directories + project roots).
    // UE engine trees live outside the workspace root (or inside a skipped
    // `Engine` dir), so they only enter the F12 index via an explicit root.
    const symDir =
      node.kind === "project"
        ? (node.listDir ?? abs)
        : node.kind === "dir"
          ? abs
          : null;
    if (symDir && !node.error && this.workspacePath) {
      const covering = coveringSymbolScanRoot(
        symDir,
        { workspaceRoot: this.workspacePath, extraRoots: this.symbolExtraRoots },
        this.isWindows() || window.jellybot?.platform === "darwin",
      );
      const group: HTMLButtonElement[] = [];
      if (covering === this.workspacePath) {
        group.push(
          this.menuItem("Indexed — workspace", () => {}, {
            disabled: true,
          }),
        );
      } else if (covering) {
        group.push(
          this.menuItem("Remove from Symbol Index", () => {
            void this.removeSymbolRoot(covering);
          }, { danger: true, hint: baseNameOf(covering) }),
        );
      } else {
        group.push(
          this.menuItem("Add to Symbol Index", () => {
            void this.addSymbolRoot(symDir);
          }, { primary: true, hint: "C++ · F12" }),
        );
      }
      menu.append(this.menuSep(), this.menuLabel("Symbol Index"), ...group);
    }

    const trailing = menu.lastElementChild;
    if (trailing?.classList.contains("devmode-ctx-sep")) trailing.remove();
    if (menu.childElementCount === 0) return;

    document.body.append(menu);
    this.ctxMenu = menu;
    const rect = menu.getBoundingClientRect();
    const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;

    const onDown = (e: PointerEvent): void => {
      if (!menu.contains(e.target as Node)) this.closeContextMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") this.closeContextMenu();
    };
    menu.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    this.ctxCleanup = () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }

  private ctxCleanup: (() => void) | null = null;

  private closeContextMenu(): void {
    this.ctxCleanup?.();
    this.ctxCleanup = null;
    this.ctxMenu?.remove();
    this.ctxMenu = null;
  }
}
