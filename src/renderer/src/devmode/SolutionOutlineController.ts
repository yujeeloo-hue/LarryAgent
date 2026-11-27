import {
  buildSlnTree,
  parseSln,
  type SlnTreeNode,
} from "../../../dotnet/slnParser.js";
import { parseMsBuildProject } from "../../../dotnet/msbuildProjectParser.js";
import { buildProjectFileTree, type ProjectFileNode } from "../../../dotnet/projectItemTree.js";
import { PRE_BUILD_TASK_ID } from "../../../shared/devTaskIds.js";
import {
  ChevronRight,
  createLucideIcon,
  ExternalLink,
  FileText,
  FolderFill,
  FolderOpenFill,
  Package,
  PackageOpen,
  SquareTerminal,
} from "../ui/originalIcons.js";
import { createLanguageIcon } from "../ui/languageIcons.js";
import { showAlert, showConfirm } from "../ui/messageDialogs.js";
import { createDevModeIcon } from "./launchIcon.js";
import { languageForPath } from "./languages.js";
import { openCommitDialog } from "./CommitDialogController.js";
import { openSvnUpdatePanel } from "../screens/conversation/gitPanel/updateFlow.js";
import { coveringSymbolScanRoot } from "./cppSymbolIndex.js";
import {
  baseNameOf,
  isUeEngineProjectPath,
  parentDirOf,
  resolveSlnRelative,
  ueProjectRootOf,
} from "./slnPaths.js";
import { debugButtonTitle, type DebugRecipe } from "../../../debug/debugCopy.js";
import type { UnrealWorkspace } from "../../../unreal/workspaceTypes.js";
import {
  attachFolder,
  detachFolder,
  loadAttachedFolderPrefs,
  mergeAttachedFolders,
  saveAttachedFolderPrefs,
} from "./attachedFolders.js";

type OutlineKind = "solution" | "folder" | "project" | "dir" | "file";

type OutlineNode = {
  key: string;
  label: string;
  kind: OutlineKind;
  path: string | null;
  listDir: string | null;
  children: OutlineNode[];
  childrenLoaded: boolean;
  expanded: boolean;
  loading?: boolean;
  error?: string;
  external?: boolean;
  projectItems?: boolean;
  itemTreeDir?: boolean;
  executable?: boolean;
  attachedRoot?: boolean;
};

const ATTACHED_KEY_PREFIX = "attached:";

export type SolutionOutlineDeps = {
  onOpenFile: (path: string) => void;
  onCommitFile?: (path: string) => boolean;
  onVcsRefreshed?: () => void;
  onTaskRun?: (task: string) => void;
  onDebugAvailable?: (
    available: boolean,
    kind: DebugRecipe | null,
  ) => void;
  onTaskStateChange?: (
    task: string,
    running: boolean,
    failed: boolean,
  ) => void;
  onDeployConfigChange?: (command: string | null) => void;
  onLintAvailable?: (available: boolean) => void;
  onBuildTitleChange?: (title: string) => void;
  isChatBusy?: () => boolean;
};

const REFRESH_COALESCE_MS = 200;
const VCS_REFRESH_COALESCE_MS = 600;
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

function pathKey(p: string): string {
  return window.jellybot?.platform === "win32" ? p.toLowerCase() : p;
}

function vcsMapDiff(
  a: Map<string, string>,
  b: Map<string, string>,
): Set<string> {
  const changed = new Set<string>();
  for (const [key, value] of a) {
    if (b.get(key) !== value) changed.add(key);
  }
  for (const key of b.keys()) {
    if (!a.has(key)) changed.add(key);
  }
  return changed;
}

const ROW_LEAD_PX = 10;
const ROW_INDENT_PX = 14;
const PAN_DURATION_MS = 100;
const TREE_ANIM_FALLBACK_MS = 200;


export class SolutionOutlineController {
  private autoLuaRoots: string[] = [];
  private unrealWorkspace: UnrealWorkspace | null = null;
  readonly root: HTMLElement;

  private readonly bodyEl: HTMLElement;

  private horizontalTarget = 0;
  private horizontalLeft = 0;
  private horizontalTweenId = 0;
  private horizontalFrom = 0;
  private horizontalStart = 0;
  private panObserver: ResizeObserver | null = null;

  private treeNodes: OutlineNode[] = [];
  private workspacePath: string | null = null;
  private engineRoot: string | null = null;
  private symbolExtraRoots: string[] = [];
  private workspaceLabel = "";
  private loadGeneration = 0;
  private destroyed = false;
  private selectedKey: string | null = null;
  private refreshTimer: number | null = null;
  private pendingProjects = false;
  private readonly pendingDirs = new Set<string>();

  private vcsKind: "git" | "svn" | "none" = "none";
  private vcsByPath = new Map<string, string>();
  private vcsDirtyDirs = new Map<string, string>();
  private vcsTimer: number | null = null;
  private ctxMenu: HTMLElement | null = null;

  readonly refreshButton: HTMLButtonElement;
  private treeRefreshing = false;
  private taskCommands = new Map<string, string>();
  private taskOrigins = new Map<string, "file" | "unreal">();
  private debugSupported = false;
  private debugKind: DebugRecipe | null = null;
  private taskConfigError: string | null = null;
  private runningTasks = new Set<string>();
  private failedTasks = new Set<string>();
  private taskConfigGeneration = 0;
  private taskCfgTimer: number | null = null;
  private pendingGenerateRefresh = false;
  private unwatchDevTaskExit: (() => void) | null = null;
  private actionPop: HTMLElement | null = null;
  private actionPopCleanup: (() => void) | null = null;
  private svnUpdateBusy = false;
  private actionPopAutoClose: number | null = null;

  private pendingReveal: string | null = null;
  private revealTimer: number | null = null;

  constructor(private readonly deps: SolutionOutlineDeps) {
    this.root = document.createElement("div");
    this.root.className = "devmode-outline";

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "devmode-outline-body";
    this.bodyEl.addEventListener("scroll", this.handleBodyScroll);
    if (typeof ResizeObserver !== "undefined") {
      this.panObserver = new ResizeObserver(() => this.syncHorizontal());
      this.panObserver.observe(this.bodyEl);
    }

    this.refreshButton = document.createElement("button");
    this.refreshButton.type = "button";
    this.refreshButton.className = "devmode-launch-btn devmode-outline-refresh";
    this.refreshButton.title = "Refresh";
    this.refreshButton.setAttribute("aria-label", "Refresh");
    this.refreshButton.disabled = true;
    this.refreshButton.append(createDevModeIcon("refresh"));
    this.refreshButton.addEventListener("click", this.refreshClicked);

    this.root.append(this.bodyEl);

    const bridge = window.jellybot;
    if (bridge?.onDevTaskExit) {
      this.unwatchDevTaskExit = bridge.onDevTaskExit((snap) =>
        this.handleDevTaskExit(snap),
      );
    }
  }


  destroy(): void {
    this.destroyed = true;
    this.loadGeneration++;
    this.taskConfigGeneration++;
    this.workspacePath = null;
    this.refreshButton.removeEventListener("click", this.refreshClicked);
    this.refreshButton.remove();
    this.bodyEl.removeEventListener("scroll", this.handleBodyScroll);
    if (this.horizontalTweenId) {
      cancelAnimationFrame(this.horizontalTweenId);
      this.horizontalTweenId = 0;
    }
    this.panObserver?.disconnect();
    this.panObserver = null;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.vcsTimer !== null) window.clearTimeout(this.vcsTimer);
    if (this.taskCfgTimer !== null) window.clearTimeout(this.taskCfgTimer);
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer);
    this.revealTimer = null;
    for (const timer of this.treeAnimTimers.values()) window.clearTimeout(timer);
    this.treeAnimTimers.clear();
    this.treeAnimKeys.clear();
    this.pendingReveal = null;
    this.unwatchDevTaskExit?.();
    this.unwatchDevTaskExit = null;
    this.closeActionPop();
    this.closeContextMenu();
  }

  async setWorkspace(path: string | null): Promise<void> {
    if (this.destroyed) return;
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
    this.pendingGenerateRefresh = false;
    this.taskConfigGeneration++;
    this.deps.onDeployConfigChange?.(null);
    this.deps.onLintAvailable?.(false);
    this.syncTaskState("build");
    this.syncTaskState(PRE_BUILD_TASK_ID);
    this.syncTaskState("deploy");
    this.treeRefreshing = false;
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
          : "Choose a workspace above to load its files.",
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
      const unreal = await bridge.getUnrealWorkspace?.(path);
      if (gen !== this.loadGeneration) return;
      this.unrealWorkspace = unreal?.ok ? unreal.workspace : null;
      this.engineRoot = this.unrealWorkspace?.engineRoot ?? null;
      if (slnFiles.length === 0) {
        const rootNode = this.makeDirNode(path, this.workspaceLabel);
        rootNode.expanded = true;
        this.treeNodes = [rootNode];
        this.render();
        await this.loadDirChildren(rootNode, gen);
        if (gen !== this.loadGeneration) return;
        this.addUnrealPrograms(rootNode);
        this.render();
        this.scheduleVcsRefresh(300);
        return;
      }

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
      if (solutions[0]) this.addUnrealPrograms(solutions[0]);
      this.autoLuaRoots = [];
      if (solutions[0]) this.applyAttachedFolders(solutions[0]);
      this.render();
      this.scheduleVcsRefresh(300);
      void this.discoverLuaRoots(path, gen);
    } catch (err) {
      if (gen !== this.loadGeneration) return;
      this.showPlaceholder(
        `Could not load outline — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }


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
      if (event.kind === "change") continue;
      this.pendingDirs.add(parentDirOf(path));
      this.pendingDirs.add(path);
    }
    if (tasksCfgChanged) this.scheduleTaskConfigRefresh();

    if (slnChanged) {
      void this.setWorkspace(this.workspacePath);
      return;
    }
    if (projectFileChanged) {
      this.pendingProjects = true;
    }
    if (this.pendingDirs.size > 0 || this.pendingProjects) {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        this.flushRefresh();
      }, REFRESH_COALESCE_MS);
    }
    this.scheduleVcsRefresh(VCS_REFRESH_COALESCE_MS);
  }


  handleVcsChanged(): void {
    if (!this.workspacePath) return;
    this.scheduleVcsRefresh(100);
  }

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
      return;
    }
    if (normalize(root) !== normalize(this.workspacePath ?? "")) return;
    if (!result.ok) return;
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
      const abs = normalize(entry.path);
      byPath.set(abs, entry.status);
      let dir = parentDirOf(abs);
      while (dir.startsWith(rootNorm)) {
        bump(dir, entry.status);
        if (dir === rootNorm) break;
        dir = parentDirOf(dir);
      }
    }
    const changedFiles = vcsMapDiff(this.vcsByPath, byPath);
    const changedDirs = vcsMapDiff(this.vcsDirtyDirs, dirtyDirs);
    if (
      this.vcsKind === result.vcs &&
      changedFiles.size === 0 &&
      changedDirs.size === 0
    ) {
      return;
    }
    this.vcsKind = result.vcs;
    this.vcsByPath = byPath;
    this.vcsDirtyDirs = dirtyDirs;
    this.patchBadges(changedFiles, changedDirs);
    this.deps.onVcsRefreshed?.();
  }

  private fileBadge(node: OutlineNode): string | undefined {
    if (!node.path) return undefined;
    return this.vcsByPath.get(normalize(node.path));
  }

  private dirBadge(node: OutlineNode): string | undefined {
    const dir = this.dirOfNode(node);
    if (!dir) return undefined;
    return this.vcsDirtyDirs.get(normalize(dir));
  }

  private buildFileBadge(badge: string | undefined): HTMLElement | null {
    if (!badge) return null;
    const chip = document.createElement("span");
    chip.className = `devmode-tree-st devmode-st-${badge.toLowerCase()}`;
    chip.textContent = badge;
    return chip;
  }

  private buildDirBadge(badge: string | undefined): HTMLElement | null {
    if (!badge) return null;
    const dot = document.createElement("span");
    dot.className = `devmode-tree-dot devmode-st-${badge.toLowerCase()}`;
    dot.title = "Contains version-control changes";
    return dot;
  }

  private patchRowBadges(row: HTMLElement, node: OutlineNode): void {
    if (node.kind === "file") {
      const badge = this.fileBadge(node);
      row.querySelector(".devmode-tree-st")?.remove();
      const chip = this.buildFileBadge(badge);
      if (chip) row.append(chip);
      row.classList.toggle("is-vcs-deleted", badge === "D");
    } else if (
      node.kind === "dir" ||
      node.kind === "project" ||
      node.kind === "solution"
    ) {
      row.querySelector(".devmode-tree-dot")?.remove();
      const dot = this.buildDirBadge(this.dirBadge(node));
      if (dot) row.append(dot);
    }
  }

  private patchBadges(changedFiles: Set<string>, changedDirs: Set<string>): void {
    this.walk(this.treeNodes, (node) => {
      const path = node.kind === "file" ? node.path : this.dirOfNode(node);
      if (!path) return;
      const changed = node.kind === "file" ? changedFiles : changedDirs;
      if (!changed.has(normalize(path))) return;
      const row = this.bodyEl.querySelector<HTMLElement>(
        `[data-key="${CSS.escape(node.key)}"]`,
      );
      if (row) this.patchRowBadges(row, node);
    });
  }


  private revealSeq = 0;

  async revealPath(absPath: string): Promise<void> {
    const target = normalize(absPath);
    if (!target) return;
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    if (!this.workspacePath || this.treeNodes.length === 0) {
      this.pendingReveal = target;
      this.armPendingReveal();
      return;
    }
    this.pendingReveal = null;
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
      behavior: "instant",
      block: "center",
      inline: "nearest",
    });
    this.syncHorizontal(true);
  }

  private armPendingReveal(): void {
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer);
    this.revealTimer = window.setTimeout(() => {
      this.revealTimer = null;
      const target = this.pendingReveal;
      this.pendingReveal = null;
      if (target) void this.revealPath(target);
    }, 400);
  }

  followActiveFile(absPath: string): void {
    if (!this.syncSelection(absPath)) {
      void this.revealPath(absPath);
      return;
    }
    if (this.selectedKey === null) return;
    const row = this.bodyEl.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(this.selectedKey)}"]`,
    );
    if (!row) return;
    const rowRect = row.getBoundingClientRect();
    const bodyRect = this.bodyEl.getBoundingClientRect();
    if (rowRect.top >= bodyRect.top && rowRect.bottom <= bodyRect.bottom) return;
    row.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    this.syncHorizontal(true);
  }

  syncSelection(absPath: string): boolean {
    if (!this.workspacePath) return false;
    const target = `file:${normalize(absPath)}`;
    const attachedTarget = `${ATTACHED_KEY_PREFIX}${target}`;
    const findVisible = (nodes: OutlineNode[]): OutlineNode | null => {
      for (const node of nodes) {
        if (node.key === target || node.key === attachedTarget) return node;
        if (node.expanded && node.childrenLoaded) {
          const hit = findVisible(node.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    const hit = findVisible(this.treeNodes);
    if (!hit) return false;
    if (this.selectedKey === hit.key) return true;
    const prevKey = this.selectedKey;
    this.selectedKey = hit.key;
    if (prevKey) {
      this.bodyEl
        .querySelector(`[data-key="${CSS.escape(prevKey)}"]`)
        ?.classList.remove("is-selected");
    }
    this.bodyEl
      .querySelector(`[data-key="${CSS.escape(hit.key)}"]`)
      ?.classList.add("is-selected");
    return true;
  }

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
        const hit = await this.revealSearch(node.children, target, gen, seq);
        if (hit) {
          node.expanded = true;
          return hit;
        }
        continue;
      }
      const dir = this.dirOfNode(node);
      if (!dir) continue;
      if (!targetKey.startsWith(`${pathKey(normalize(dir))}/`)) continue;
      const wasExpanded = node.expanded;
      node.expanded = true;
      if (!node.childrenLoaded) {
        await this.loadDirChildren(node, gen, { silent: true });
        if (gen !== this.loadGeneration || seq !== this.revealSeq) {
          node.expanded = wasExpanded;
          return null;
        }
      }
      const hit = await this.revealSearch(node.children, target, gen, seq);
      if (hit) return hit;
      node.expanded = wasExpanded;
    }
    return null;
  }

  private flushRefresh(): void {
    const dirs = [...this.pendingDirs];
    this.pendingDirs.clear();
    const rebuildProjects = this.pendingProjects;
    this.pendingProjects = false;
    const gen = this.loadGeneration;
    void (async () => {
      if (rebuildProjects) {
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

  private async reloadDirChildren(node: OutlineNode): Promise<void> {
    if (!node.listDir) return;
    if (node.projectItems || node.itemTreeDir) return;
    const oldByKey = new Map(node.children.map((c) => [c.key, c]));
    node.children = [];
    node.childrenLoaded = false;
    await this.loadDirChildren(node, this.loadGeneration, { silent: true });
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

  private async refreshOutline(scope: OutlineNode | null): Promise<void> {
    if (!this.workspacePath || this.treeRefreshing) return;
    const gen = this.loadGeneration;
    this.treeRefreshing = true;
    this.syncRefreshButton();
    try {
      if (!scope && this.unrealWorkspace && window.jellybot?.getUnrealWorkspace) {
        const updated = await window.jellybot.getUnrealWorkspace(this.workspacePath, true);
        if (gen !== this.loadGeneration) return;
        if (updated.ok) this.unrealWorkspace = updated.workspace;
        const removeSupplement = (nodes: OutlineNode[]) => {
          for (const node of nodes) {
            node.children = node.children.filter(child => !child.key.startsWith("unreal-project:"));
            removeSupplement(node.children);
          }
        };
        removeSupplement(this.treeNodes);
      }
      const roots = scope ? [scope] : this.treeNodes;
      for (const node of roots) {
        if (gen !== this.loadGeneration) return;
        await this.refreshOutlineNode(node, gen, scope !== null);
      }
      if (gen !== this.loadGeneration) return;
      if (!scope && this.treeNodes[0]) this.addUnrealPrograms(this.treeNodes[0]);
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

  private async refreshOutlineNode(
    node: OutlineNode,
    gen: number,
    explicit: boolean,
  ): Promise<void> {
    if (gen !== this.loadGeneration || node.kind === "file") return;
    if (node.itemTreeDir) return;

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

  private addUnrealPrograms(root: OutlineNode): void {
    if (!this.unrealWorkspace?.projects.length) return;
    const paths = new Set<string>();
    let programs: OutlineNode | undefined;
    this.walk(root.children, node => {
      if (node.kind === "project" && node.path) paths.add(normalize(node.path).toLowerCase());
      if (node.kind === "folder" && node.label === "Programs") programs ??= node;
    });
    const extra = this.unrealWorkspace.projects.filter(project => !paths.has(normalize(project.path).toLowerCase())).map(project => ({
      key: `unreal-project:${root.key}:${project.id}`, label: project.name, kind: "project" as const,
      path: normalize(project.path), listDir: normalize(project.sourceRoot), children: [], childrenLoaded: false, expanded: false,
      external: !normalize(project.sourceRoot).toLowerCase().startsWith(`${normalize(this.workspacePath ?? "").toLowerCase()}/`),
    }));
    if (!extra.length) return;
    if (programs) programs.children.push(...extra);
    else root.children.push({ key: `unreal-programs:${root.key}`, label: "Programs", kind: "folder", path: null, listDir: null,
      children: extra, childrenLoaded: true, expanded: false });
  }

  private attachedFolderHost(): OutlineNode | null {
    return this.treeNodes.find((node) => node.kind === "solution") ?? null;
  }

  private async discoverLuaRoots(workspace: string, gen: number): Promise<void> {
    let roots: string[] = [];
    try {
      roots = (await window.jellybot?.findLuaScriptRoots?.(workspace)) ?? [];
    } catch {
      return;
    }
    if (gen !== this.loadGeneration || roots.length === 0) return;
    this.autoLuaRoots = roots.map(normalize);
    const host = this.attachedFolderHost();
    if (!host) return;
    this.applyAttachedFolders(host);
    this.render();
  }

  private applyAttachedFolders(host: OutlineNode): void {
    const workspace = this.workspacePath;
    if (!workspace) return;
    const dirs = mergeAttachedFolders(this.autoLuaRoots, loadAttachedFolderPrefs(workspace));
    const previous = new Map(
      host.children.filter((child) => child.attachedRoot).map((child) => [child.key, child]),
    );
    host.children = host.children.filter((child) => !child.attachedRoot);
    for (const dir of dirs) {
      const rel = this.relativeToWorkspace(dir);
      const node = previous.get(`${ATTACHED_KEY_PREFIX}dir:${normalize(dir)}`) ??
        this.makeDirNode(dir, rel || this.workspaceLabel, ATTACHED_KEY_PREFIX);
      node.attachedRoot = true;
      if (rel === normalize(dir)) node.external = true;
      host.children.push(node);
    }
  }

  private async attachFolderFromPicker(): Promise<void> {
    const workspace = this.workspacePath;
    const host = this.attachedFolderHost();
    if (!workspace || !host) return;
    const dir = await window.jellybot?.pickWorkspaceFolder?.();
    if (!dir || workspace !== this.workspacePath) return;
    saveAttachedFolderPrefs(workspace, attachFolder(loadAttachedFolderPrefs(workspace), dir));
    this.applyAttachedFolders(host);
    this.render();
  }

  private detachAttachedFolder(node: OutlineNode): void {
    const workspace = this.workspacePath;
    const host = this.attachedFolderHost();
    if (!workspace || !host || !node.path) return;
    saveAttachedFolderPrefs(
      workspace,
      detachFolder(loadAttachedFolderPrefs(workspace), node.path, this.autoLuaRoots),
    );
    if (this.selectedKey?.startsWith(ATTACHED_KEY_PREFIX)) this.selectedKey = null;
    this.applyAttachedFolders(host);
    this.render();
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
        key: `slnfolder:${slnPath}:${node.guid}`,
        label: node.name,
        kind: "folder",
        path: null,
        listDir: null,
        children,
        childrenLoaded: true,
        expanded: false,
      };
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(node.project?.path ?? "")) {
      return this.makeErrorNode(node.name, "Web project (no local path)");
    }
    const projectPath = resolveSlnRelative(slnPath, node.project?.path ?? "");
    const ueRoot = ueProjectRootOf(projectPath);
    const engineRoot = isUeEngineProjectPath(projectPath) ? this.engineRoot : null;
    const unrealProject = this.unrealWorkspace?.projects.find(p => normalize(p.path).toLowerCase() === normalize(projectPath).toLowerCase());
    const projectDir =
      (unrealProject ? normalize(unrealProject.sourceRoot) : null) ?? engineRoot ?? ueRoot ?? (projectPath ? parentDirOf(projectPath) : null);
    const external =
      !!projectDir &&
      !!this.workspacePath &&
      normalize(projectDir).toLowerCase() !==
        normalize(this.workspacePath).toLowerCase() &&
      !projectDir.toLowerCase().startsWith(
        `${normalize(this.workspacePath).toLowerCase()}/`,
      );
    return {
      key: `project:${slnPath}:${node.guid}`,
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

  private makeDirNode(path: string, label: string, keyPrefix = ""): OutlineNode {
    return {
      key: `${keyPrefix}dir:${normalize(path)}`,
      label,
      kind: "dir",
      path,
      listDir: path,
      children: [],
      childrenLoaded: false,
      expanded: false,
    };
  }

  private makeFileNode(path: string, executable?: boolean, keyPrefix = ""): OutlineNode {
    return {
      key: `${keyPrefix}file:${normalize(path)}`,
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


  private async loadDirChildren(
    node: OutlineNode,
    gen: number,
    opts?: { silent?: boolean },
  ): Promise<void> {
    if (!node.listDir || node.childrenLoaded) return;
    const silent = opts?.silent === true;
    node.loading = true;
    if (!silent) this.render();
    const bridge = window.jellybot;
    if (!bridge) {
      node.loading = false;
      node.error = "Bridge unavailable";
      node.childrenLoaded = true;
      if (!silent) this.render();
      return;
    }
    try {
      let result = await bridge.listDevModeDir(node.listDir);
      if (gen !== this.loadGeneration) return;

      if (node.kind === "project" && node.path && result.ok) {
        const built = await this.buildProjectItemTree(node, gen, bridge);
        if (gen !== this.loadGeneration) return;
        if (built) {
          node.loading = false;
          node.children = built;
          node.childrenLoaded = true;
          node.projectItems = true;
          if (!silent) this.render();
          return;
        }
      }

      node.loading = false;
      if (result.ok) {
        const keyPrefix = node.key.startsWith(ATTACHED_KEY_PREFIX) ? ATTACHED_KEY_PREFIX : "";
        node.children = result.entries.map((entry) =>
          entry.kind === "dir"
            ? this.makeDirNode(entry.path, entry.name, keyPrefix)
            : this.makeFileNode(entry.path, entry.executable, keyPrefix),
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
    if (!silent) this.render();
  }

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
      node.error = message ?? "Could not read project file";
      return null;
    }

    const info = parseMsBuildProject(text);
    if (info.sdkStyle) return null;

    const projectDir = node.listDir ?? parentDirOf(projectPath);
    if (!projectDir) return null;
    const resolved = info.items
      .filter(item => !item.include.includes("$(") && !item.include.includes("*"))
      .map((item) => resolveSlnRelative(projectPath, item.include));
    if (resolved.length === 0) return null;
    const seen = new Set<string>();
    const unique = resolved.filter((p) => {
      const key = p.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const inside = unique.filter(p => p.toLowerCase().startsWith(`${projectDir.toLowerCase()}/`));
    const outside = unique.filter(p => !inside.includes(p));
    const tree = this.fromProjectFileNodes(buildProjectFileTree(projectDir, inside) ?? []);
    if (outside.length) tree.push({ key: `linked:${projectPath}`, label: "External files", kind: "folder", path: null, listDir: null,
      children: outside.map(path => ({ ...this.makeFileNode(path), label: path, external: true })), childrenLoaded: true, expanded: false, external: true });
    return tree.length ? tree : null;
  }

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
        itemTreeDir: true,
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


  private treeAnimKeys = new Set<string>();
  private treeAnimTimers = new Map<string, number>();

  private onTreeAnimEnd(key: string, container: HTMLElement, done: () => void): void {
    const finish = (): void => {
      window.clearTimeout(timer);
      container.removeEventListener("transitionend", onEnd);
      this.treeAnimTimers.delete(key);
      this.treeAnimKeys.delete(key);
      if (!this.destroyed) done();
    };
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === container && event.propertyName === "height") finish();
    };
    const timer = window.setTimeout(finish, TREE_ANIM_FALLBACK_MS);
    this.treeAnimTimers.set(key, timer);
    container.addEventListener("transitionend", onEnd);
  }

  private motionReduced(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

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
    void container.offsetHeight;
    container.style.transition = "height 170ms ease";
    container.style.height = `${target}px`;
    this.onTreeAnimEnd(node.key, container, () => {
      container.style.height = "";
      container.style.overflow = "";
      container.style.transition = "";
      this.syncHorizontal();
    });
  }

  private animateCollapse(node: OutlineNode): void {
    const container = this.childContainerOf(node.key);
    if (!container || container.scrollHeight <= 0) {
      this.render();
      return;
    }
    this.treeAnimKeys.add(node.key);
    this.bodyEl
      .querySelector(`[data-key="${CSS.escape(node.key)}"]`)
      ?.setAttribute("aria-expanded", "false");
    container.style.overflow = "hidden";
    container.style.height = `${container.scrollHeight}px`;
    void container.offsetHeight;
    container.style.transition = "height 170ms ease";
    container.style.height = "0px";
    this.onTreeAnimEnd(node.key, container, () => this.render());
  }



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


  private syncHorizontal(immediate = false): void {
    const want = this.panOffsetOf(this.baseLevel());
    const changed = Math.abs(want - this.horizontalTarget) >= 0.5;
    this.horizontalTarget = want;
    if (this.horizontalTweenId) {
      if (changed) this.startHorizontalTween(false);
      return;
    }
    if (
      changed ||
      immediate ||
      Math.abs(want - this.horizontalLeft) >= 0.5
    ) {
      this.startHorizontalTween(immediate);
    }
  }

  private panOffsetOf(depth: number): number {
    return depth <= 0 ? 0 : ROW_LEAD_PX + depth * ROW_INDENT_PX;
  }

  private applyPan(left: number): void {
    this.bodyEl.style.setProperty("--pan-x", `${-left}px`);
  }

  private baseLevel(): number {
    const view = this.bodyEl.getBoundingClientRect();
    let best = Number.POSITIVE_INFINITY;
    for (const row of this.bodyEl.querySelectorAll<HTMLElement>(
      ".devmode-tree-row",
    )) {
      const rect = row.getBoundingClientRect();
      const middle = (rect.top + rect.bottom) / 2;
      if (middle < view.top || middle > view.bottom) continue;
      const depth = Number(row.style.getPropertyValue("--depth")) || 0;
      if (depth < best) best = depth;
    }
    return Number.isFinite(best) ? best : 0;
  }

  private startHorizontalTween(immediate: boolean): void {
    if (this.horizontalTweenId) {
      cancelAnimationFrame(this.horizontalTweenId);
      this.horizontalTweenId = 0;
    }
    const target = this.horizontalTarget;
    const from = this.horizontalLeft;
    if (
      immediate ||
      this.motionReduced() ||
      typeof requestAnimationFrame !== "function" ||
      Math.abs(target - from) < 0.5
    ) {
      this.horizontalLeft = target;
      this.applyPan(target);
      return;
    }
    this.horizontalFrom = from;
    this.horizontalStart = performance.now();
    this.horizontalTweenId = requestAnimationFrame(this.horizontalStep);
  }

  private readonly horizontalStep = (now: number): void => {
    const t = Math.min(1, (now - this.horizontalStart) / PAN_DURATION_MS);
    const eased = 1 - (1 - t) ** 3;
    this.horizontalLeft =
      this.horizontalFrom +
      (this.horizontalTarget - this.horizontalFrom) * eased;
    this.applyPan(this.horizontalLeft);
    if (t < 1) {
      this.horizontalTweenId = requestAnimationFrame(this.horizontalStep);
    } else {
      this.horizontalTweenId = 0;
      this.horizontalLeft = this.horizontalTarget;
      this.applyPan(this.horizontalLeft);
    }
  };

  private readonly handleBodyScroll = (): void => {
    this.syncHorizontal();
  };

  private render(): void {
    const scrollTop = this.bodyEl.scrollTop;
    this.bodyEl.replaceChildren();
    for (const node of this.treeNodes) {
      this.bodyEl.append(this.renderBranch(node, 0));
    }
    this.bodyEl.scrollTop = scrollTop;
    this.syncHorizontal();
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

    const inner = document.createElement("div");
    inner.className = "devmode-tree-row-inner";
    inner.append(tw, icon, label);
    row.append(inner);

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

    if (node.kind === "file") {
      const badge = this.fileBadge(node);
      const chip = this.buildFileBadge(badge);
      if (chip) row.append(chip);
      if (badge === "D") row.classList.add("is-vcs-deleted");
    } else if (
      node.kind === "dir" ||
      node.kind === "project" ||
      node.kind === "solution"
    ) {
      const dot = this.buildDirBadge(this.dirBadge(node));
      if (dot) row.append(dot);
    }

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openContextMenu(event, node, row);
    });
    row.addEventListener("click", () => {
      if (node.kind === "file") {
        this.selectedKey = node.key;
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
        const loadingInner = document.createElement("div");
        loadingInner.className = "devmode-tree-row-inner";
        loadingInner.textContent = "Loading…";
        loading.append(loadingInner);
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
      await showAlert(`Could not run "${node.label}" — ${result.message ?? "unknown error"}`, {
        title: "Run executable",
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
        const langKey = languageForPath(node.path ?? node.label).icon;
        return langKey === "text"
          ? createLucideIcon(FileText, { size: 14 })
          : createLanguageIcon(langKey, createLucideIcon);
      }
    }
  }


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
      return;
    }
    this.syncBuildTitle();
    this.deps.onLintAvailable?.(this.taskCommands.has(PRE_BUILD_TASK_ID));
    this.deps.onDeployConfigChange?.(this.taskCommands.get("deploy") ?? null);
  }

  private setDebugSupported(available: boolean): void {
    this.debugSupported = available;
    this.deps.onDebugAvailable?.(available, this.debugKind);
  }


  private async refreshSymbolRoots(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge?.getCppSymbolExtraRoots || !root) return;
    try {
      const res = await bridge.getCppSymbolExtraRoots(root);
      if (root !== this.workspacePath) return;
      this.symbolExtraRoots = res.ok ? res.extraRoots : [];
    } catch {
      return;
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
        if (res.message) void showAlert(res.message, { title: "Symbol index", type: "info" });
        return;
      }
      void showAlert(`Add to symbol index failed — ${res.message}`, { title: "Symbol index" });
    } catch (err) {
      void showAlert(
        `Add to symbol index failed — ${err instanceof Error ? err.message : String(err)}`,
        { title: "Symbol index" },
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
      void showAlert(`Remove from symbol index failed — ${res.message}`, { title: "Symbol index" });
    } catch (err) {
      void showAlert(
        `Remove from symbol index failed — ${err instanceof Error ? err.message : String(err)}`,
        { title: "Symbol index" },
      );
    }
  }

  private async refreshRunningTasks(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (!bridge || !root) return;
    const generation = this.loadGeneration;
    try {
      const state = await bridge.getDevTaskState(root);
      if (generation !== this.loadGeneration) return;
      this.runningTasks = new Set(state.active.map((r) => r.task));
    } catch {
      return;
    }
    this.syncTaskState("build");
    this.syncTaskState(PRE_BUILD_TASK_ID);
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
    if (snap.task === "generate" && this.pendingGenerateRefresh) {
      this.pendingGenerateRefresh = false;
      if (!failed) {
        void this.refreshOutline(null);
        void this.refreshTaskConfig();
      }
    }
  }

  private syncTaskState(task: string): void {
    this.deps.onTaskStateChange?.(
      task,
      this.runningTasks.has(task),
      this.failedTasks.has(task),
    );
  }

  private readonly refreshClicked = (): void => {
    void this.refreshWithProjectFiles();
  };

  private async refreshWithProjectFiles(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath;
    if (
      !bridge?.checkUnrealProjectFilesStale ||
      !root ||
      !this.taskCommands.has("generate")
    ) {
      void this.refreshOutline(null);
      return;
    }
    let stale: Awaited<ReturnType<typeof bridge.checkUnrealProjectFilesStale>>;
    try {
      stale = await bridge.checkUnrealProjectFilesStale(root);
    } catch {
      void this.refreshOutline(null);
      return;
    }
    if (stale.ok && stale.stale && !this.runningTasks.has("generate")) {
      this.pendingGenerateRefresh = true;
      await this.runTask("generate");
      if (!this.runningTasks.has("generate")) this.pendingGenerateRefresh = false;
      return;
    }
    void this.refreshOutline(null);
  }

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

  runBuild(): void {
    void this.runTask("build");
  }

  runLint(): void {
    if (this.taskCommands.has(PRE_BUILD_TASK_ID)) void this.runTask(PRE_BUILD_TASK_ID);
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
      this.deps.onTaskRun?.(task);
      return;
    }
    this.failedTasks.delete(task);
    this.runningTasks.add(task);
    this.syncTaskState(task);
    this.deps.onTaskRun?.(task);
    const generation = this.loadGeneration;
    const label = task === PRE_BUILD_TASK_ID ? "Lint" : task;
    try {
      const res = await bridge.runDevTask(root, task);
      if (root !== this.workspacePath || generation !== this.loadGeneration) return;
      if (!res.ok && !res.runId) {
        this.runningTasks.delete(task);
        this.syncTaskState(task);
        void showAlert(`${label} failed to start — ${res.message}`, { title: label });
      }
    } catch (err) {
      if (root !== this.workspacePath || generation !== this.loadGeneration) return;
      this.runningTasks.delete(task);
      this.syncTaskState(task);
      void showAlert(
        `${label} failed to start — ${err instanceof Error ? err.message : String(err)}`,
        { title: label },
      );
    }
  }

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
        void showAlert(`Could not create ${cfgPath} — ${created.message}`, { title: "Tasks" });
        return;
      }
      void this.refreshTaskConfig();
    }
    this.deps.onOpenFile(cfgPath);
  }


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
        void showAlert(`${verb} failed — ${result.message ?? "unknown error"}`, { title: verb });
        return;
      }
    } catch (err) {
      void showAlert(
        `${verb} failed — ${err instanceof Error ? err.message : String(err)}`,
        { title: verb },
      );
      return;
    }
    this.scheduleVcsRefresh(100);
  }

  private async commitPaths(paths: string[], title: string, filePath?: string | null): Promise<void> {
    const root = this.workspacePath;
    if (!root || paths.length === 0) return;
    if (this.deps.isChatBusy?.()) {
      void showAlert("Wait for the current turn to finish before committing.", {
        title: "Commit",
        type: "warning",
      });
      return;
    }
    if (filePath && this.deps.onCommitFile?.(filePath)) return;
    const result = await openCommitDialog({
      workspacePath: root,
      paths,
      title,
    });
    if (result.committed) this.scheduleVcsRefresh(100);
  }

  private async runSvnUpdate(
    anchor: HTMLElement,
    targets: string[],
    label: string,
  ): Promise<void> {
    const root = this.workspacePath;
    if (!root || this.svnUpdateBusy) return;
    void anchor;
    void label;
    this.svnUpdateBusy = true;
    this.closeActionPop();
    try {
      await openSvnUpdatePanel({ root, paths: targets });
      this.scheduleVcsRefresh(100);
    } finally {
      this.svnUpdateBusy = false;
    }
  }

  private confirmDestructive(verb: string, label: string): Promise<boolean> {
    return showConfirm(
      `${verb} "${label}"? Uncommitted changes will be lost. This cannot be undone.`,
      { title: verb, confirmLabel: verb, destructive: true },
    );
  }

  private trashLabel(): string {
    return this.isWindows() ? "Recycle Bin" : "Trash";
  }

  private isDeletable(node: OutlineNode): boolean {
    if (!node.path || node.error || node.itemTreeDir || node.attachedRoot) return false;
    if (node.kind !== "file" && node.kind !== "dir") return false;
    return this.isInsideWorkspace(node.path);
  }

  private isInsideWorkspace(abs: string): boolean {
    const root = this.workspacePath ? pathKey(normalize(this.workspacePath)) : "";
    if (!root) return false;
    return pathKey(normalize(abs)).startsWith(`${root}/`);
  }

  private async deleteNode(node: OutlineNode): Promise<void> {
    const abs = node.path;
    const bridge = window.jellybot;
    if (!abs || !bridge || !this.isDeletable(node)) return;
    const bin = this.trashLabel();
    const ok = await showConfirm(`Move "${node.label}" to the ${bin}?`, {
      title: "Delete",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const trash = bridge.trashItem;
    if (typeof trash !== "function") {
      await showAlert("Deleting files is not available in this build.", {
        title: "Delete",
        type: "error",
      });
      return;
    }
    const result = await trash(abs);
    if (!result.ok) {
      await showAlert(
        result.message || `Could not move "${node.label}" to the ${bin}.`,
        { title: "Delete", type: "error" },
      );
      return;
    }
    if (this.selectedKey === node.key) this.selectedKey = null;
    if (!this.removeTreeNode(abs)) {
      await this.refreshDir(parentDirOf(normalize(abs)));
    }
    this.render();
    this.scheduleVcsRefresh(150);
  }

  private removeTreeNode(abs: string): boolean {
    const target = pathKey(normalize(abs));
    let removed = false;
    const prune = (nodes: OutlineNode[]): OutlineNode[] => {
      const kept: OutlineNode[] = [];
      for (const node of nodes) {
        if (node.path && pathKey(normalize(node.path)) === target) {
          removed = true;
          continue;
        }
        if (node.children.length > 0) node.children = prune(node.children);
        kept.push(node);
      }
      return kept;
    };
    this.treeNodes = prune(this.treeNodes);
    return removed;
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

    if (!isFile && !node.itemTreeDir) {
      menu.append(
        this.menuItem("Refresh", () => {
          void this.refreshOutline(node);
        }),
      );
      if (node.kind === "solution") {
        menu.append(this.menuItem("Attach Folder…", () => {
          void this.attachFolderFromPicker();
        }));
      }
      if (node.attachedRoot) {
        menu.append(this.menuItem("Detach Folder", () => {
          this.detachAttachedFolder(node);
        }));
      }
      menu.append(this.menuSep());
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

    if (this.isDeletable(node)) {
      menu.append(
        this.menuSep(),
        this.menuItem(
          "Delete…",
          () => {
            void this.deleteNode(node);
          },
          { danger: true, hint: this.trashLabel() },
        ),
      );
    }

    if (this.unrealWorkspace && this.taskCommands.has("generate")) {
      if (menu.lastElementChild && !menu.lastElementChild.classList.contains("devmode-ctx-sep")) {
        menu.append(this.menuSep());
      }
      menu.append(
        this.menuLabel("Unreal"),
        this.menuItem(
          "Generate Project Files",
          () => {
            this.pendingGenerateRefresh = true;
            void this.runTask("generate").then(() => {
              if (!this.runningTasks.has("generate")) {
                this.pendingGenerateRefresh = false;
              }
            });
          },
          {
            disabled: this.runningTasks.has("generate") || this.runningTasks.has("build"),
            hint: "UBT",
          },
        ),
      );
    }

    const dirForOps =
      node.kind === "project" ? (node.listDir ?? abs) : abs;
    if (this.vcsKind === "git" && bridge) {
      const group: HTMLButtonElement[] = [];
      if (isFile && rel && badge) {
        group.push(
          this.menuItem("Commit…", () => {
            void this.commitPaths([rel], `Commit "${node.label}"`, abs);
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
                void this.confirmDestructive("Restore", node.label).then((ok) => {
                  if (!ok) return;
                  void this.runVcs(
                    { kind: "git-discard", paths: [rel] },
                    "Restore",
                  );
                });
              },
              { danger: true },
            ),
          );
        } else if (badge !== "U") {
          group.push(
            this.menuItem(
              "Discard Changes…",
              () => {
                void this.confirmDestructive("Discard", node.label).then((ok) => {
                  if (!ok) return;
                  void this.runVcs(
                    { kind: "git-discard", paths: [rel] },
                    "Discard",
                  );
                });
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
                void this.commitPaths(targets, `Commit "${node.label}"`, isFile ? abs : undefined);
              },
            ),
          );
          group.push(
            this.menuItem(
              isFile ? "SVN Revert…" : `SVN Revert ${targets.length} Change(s)…`,
              () => {
                void this.confirmDestructive("Revert", node.label).then((ok) => {
                  if (!ok) return;
                  void this.runVcs(
                    { kind: "svn-revert", paths: targets },
                    "SVN revert",
                  );
                });
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
