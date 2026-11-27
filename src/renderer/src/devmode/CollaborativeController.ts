import type * as Monaco from "monaco-editor";
import type { CollaborativeEditorDraft, CollaborativeEntry, CollaborativeFile, CollaborativeRepository, CollaborativeRequest, CollaborativeResult, CollaborativeSide } from "../../../shared/collaborative.js";
import { ChevronRight, FolderFill, FolderOpenFill, X, createLucideIcon } from "../ui/originalIcons.js";
import { AppDropdown } from "../ui/appDropdown.js";
import { createLanguageIcon } from "../ui/languageIcons.js";
import { showAlert, showConfirm } from "../ui/messageDialogs.js";
import { languageForPath } from "./languages.js";
import { createDevModeIcon } from "./launchIcon.js";
import type { EditorAreaController } from "./EditorAreaController.js";
import { resolveDevModeTheme } from "./monacoSetup.js";
import { getDevModeEditorFont } from "../state/devModePreferences.js";
import { dismissDevMenu, showDevMenu, type DevMenuItem } from "./ctxMenu.js";
import { openBranchCommitDialog } from "./CommitDialogController.js";
import { devModeDiffLayout, devModeEditorScrollbar } from "./editorStyle.js";
import { bindDiffOverview } from "./diffOverview.js";
import { withButtonLoading } from "./buttonLoading.js";
import "./collaborative.css";

type Context = { repository: CollaborativeRepository; path: string; localPath: string };
type Document = { workspace: string; context: Context; model: Monaco.editor.ITextModel; file: CollaborativeFile; saved: string; pending: Promise<unknown> | null; saving: Promise<void> | null; listener: Monaco.IDisposable };
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*/, "");
}
const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "");
const pathKey = (s: string): string => window.jellybot?.platform === "win32" ? norm(s).toLowerCase() : norm(s);
const element = (tag: string, className = "", text = ""): HTMLElement => { const e = document.createElement(tag); e.className = className; e.textContent = text; return e; };
function button(label: string, action: () => void, className = "devmode-launch-btn"): HTMLButtonElement {
  const b = document.createElement("button"); b.type = "button"; b.className = className; b.title = label; b.setAttribute("aria-label", label); b.addEventListener("click", action); return b;
}

export class CollaborativeController {
  readonly tree = element("div", "devmode-outline collaborative-tree");
  private readonly body = element("div", "devmode-outline-body");
  private readonly toggle: HTMLButtonElement;
  private readonly settings: HTMLButtonElement;
  private readonly editorToggle: HTMLButtonElement;
  private readonly host = element("section", "collaborative-editor");
  private readonly headings = element("div", "devmode-diff-headings");
  private readonly localHeading = element("span", "", "Working copy");
  private readonly targetHeading = element("span", "", "Collaborative branch");
  private readonly canvas = element("div", "collaborative-canvas");
  private readonly message = element("div", "collaborative-notice");
  private readonly tab = element("div", "devmode-tab is-active is-collaborative-tab");
  private readonly tabLabel = element("span", "devmode-tab-label");
  private workspace: string | null = null;
  private repositories: CollaborativeRepository[] = [];
  private repositoryScan: Promise<void> | null = null;
  private repositoryEpoch = 0;
  private branchVersions = new Map<string, boolean>();
  private versionChecks = new Set<string>();
  private failedVersionChecks = new Set<string>();
  private enabled = false;
  private active = false;
  private visible = false;
  private localPath: string | null = null;
  private selection: Context | null = null;
  private document: Document | null = null;
  private documents = new Map<string, Document>();
  private reading = new Map<string, Promise<Document>>();
  private single: Monaco.editor.IStandaloneCodeEditor | null = null;
  private diff: Monaco.editor.IStandaloneDiffEditor | null = null;
  private diffOverview: Monaco.IDisposable | null = null;
  private original: Monaco.editor.ITextModel | null = null;
  private generation = 0;
  private viewGeneration = 0;
  private preparingLocalPath: string | null = null;
  private destroyed = false;
  private entries = new Map<string, CollaborativeEntry[]>();
  private expanded = new Set<string>();
  private loading = new Set<string>();
  private treeGeneration = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | undefined;
  private popup: HTMLElement | null = null;
  private repositoryDropdown: AppDropdown | null = null;
  private syncSettings: (() => void) | null = null;
  private commitSession: AbortController | null = null;
  constructor(private readonly options: { area: EditorAreaController; localTree: HTMLElement; headerActions: HTMLElement; isChatBusy?: () => boolean }) {
    this.toggle = button("Collaborative Branch Project", () => void this.toggleTree()); this.toggle.append(createDevModeIcon("branch"));
    this.settings = button("Repository settings", () => { if (this.popup) this.closeSettings(); else this.openSettings(); }, "devmode-launch-btn devmode-build-selector");
    this.settings.append(element("span", "devmode-build-triangle")); this.settings.setAttribute("aria-haspopup", "dialog");
    options.headerActions.append(this.toggle, this.settings);
    this.editorToggle = button("Toggle collaborative dual view", () => void this.toggleEditor()); this.editorToggle.append(createDevModeIcon("branch")); options.area.appendFab(this.editorToggle);
    this.headings.append(this.localHeading, this.targetHeading);
    this.message.setAttribute("role", "status"); this.host.append(this.headings, this.canvas, this.message);
    const close = button("Return to local editor", () => this.leave(), "devmode-tab-close"); close.textContent = "×"; this.tab.append(this.tabLabel, close);
    options.area.installCollaborativeView(this.host, this.tab, { save: () => this.saveFocused(), exit: () => this.leave() });
    this.tree.append(this.body); this.update();
    document.addEventListener("pointerdown", this.outside, true);
    document.addEventListener("keydown", this.escape);
    window.addEventListener("focus", this.focus);
    window.addEventListener("beforeunload", this.beforeUnload);
    this.unsubscribe = window.jellybot?.onCollaborativeChanged?.(payload => {
      if (this.workspace && pathKey(payload.workspacePath) === pathKey(this.workspace)) this.scheduleRefresh();
    });
  }
  private async call(request: Omit<CollaborativeRequest, "workspacePath">, workspace = this.workspace): Promise<CollaborativeResult> {
    if (!workspace || !window.jellybot?.collaborativeBranch) throw new Error("Collaborative Branch Project is unavailable");
    return window.jellybot.collaborativeBranch({ ...request, workspacePath: workspace });
  }
  private error(error: unknown): void {
    const text = errorMessage(error);
    this.message.textContent = text;
    const target = this.popup?.querySelector(".collaborative-settings-status"); if (target) target.textContent = text;
    if (!this.visible && !this.popup) { this.openSettings(false); const status = (this.popup as HTMLElement | null)?.querySelector(".collaborative-settings-status"); if (status) status.textContent = text; }
  }
  async setWorkspace(workspace: string | null): Promise<void> {
    const generation = ++this.generation;
    this.commitSession?.abort();
    this.commitSession = null;
    dismissDevMenu();
    this.closeSettings();
    this.leave(); this.workspace = workspace; this.localPath = null; this.repositories = []; this.repositoryScan = null; this.branchVersions.clear(); this.versionChecks.clear(); this.failedVersionChecks.clear(); this.enabled = false; this.entries.clear(); this.expanded.clear(); this.loading.clear(); this.selection = null; this.update();
    if (!workspace) return;
    try {
      await this.scanRepositories();
    } catch (error) { if (generation === this.generation) this.error(error); }
  }
  private scanRepositories(): Promise<void> {
    if (this.repositoryScan) return this.repositoryScan;
    const workspace = this.workspace, generation = this.generation;
    if (!workspace || this.destroyed) return Promise.resolve();
    this.repositoryEpoch++;
    const scan = this.call({ op: "scan" }, workspace).then(result => {
      if (generation !== this.generation || this.destroyed) return;
      this.repositories = result.repositories ?? []; this.enabled = result.enabled === true;
      for (const key of this.failedVersionChecks) this.branchVersions.delete(key);
      this.failedVersionChecks.clear();
      if (this.selection) {
        const repository = this.repositories.find(r => r.id === this.selection!.repository.id);
        this.selection = repository ? { ...this.selection, repository } : null;
      }
      this.update(); this.renderTree();
      if (this.expanded.size) void this.refreshTree().catch(error => { if (generation === this.generation) this.error(error); });
    }).finally(() => {
      if (this.repositoryScan === scan) { this.repositoryScan = null; this.syncSettings?.(); }
    });
    this.repositoryScan = scan; this.syncSettings?.();
    return scan;
  }
  onLocalFile(path: string): void {
    this.localPath = path;
    if (this.preparingLocalPath && pathKey(path) === pathKey(this.preparingLocalPath)) return;
    this.selection = null; this.leave(); this.update(); if (this.enabled) this.renderTree();
  }
  onLocalDocumentChanged(): void {
    if (!this.selection) this.localPath = this.options.area.getActiveDocument()?.path ?? null;
    this.update();
  }
  onLocalFilesChanged(rootPath: string, events: Array<{ kind: string }>): void {
    if (this.enabled && this.workspace && pathKey(rootPath) === pathKey(this.workspace) && events.some(event => event.kind !== "change")) {
      this.scheduleRefresh();
    }
  }
  private context(): Context | null {
    if (this.selection && this.visible) return this.selection;
    const local = this.options.area.getActiveDocument()?.path;
    return local ? this.contextForLocalPath(local) : null;
  }
  private contextForLocalPath(local: string): Context | null {
    const repo = this.repositories.filter(r => pathKey(local).startsWith(pathKey(r.root) + "/")).sort((a, b) => b.root.length - a.root.length)[0];
    return repo ? { repository: repo, path: norm(local).slice(norm(repo.root).length + 1), localPath: local } : null;
  }
  private versionKey(context: Context | null): string | null {
    const binding = context?.repository.binding;
    return context && binding && this.workspace ? JSON.stringify([this.workspace, context.repository.id, binding.branch, binding.directory, binding.revision, context.path]) : null;
  }
  private ready(): boolean {
    const key = this.versionKey(this.context());
    return key !== null && this.branchVersions.get(key) === true;
  }
  private checkBranchVersion(context: Context | null): void {
    const key = this.versionKey(context);
    if (!context || !key || this.branchVersions.has(key) || this.versionChecks.has(key)) return;
    const generation = this.generation;
    this.versionChecks.add(key);
    void this.call({ op: "exists", repositoryId: context.repository.id, path: context.path }).then(result => {
      if (generation !== this.generation || this.destroyed || this.branchVersions.get(key) === true) return;
      this.branchVersions.set(key, result.exists === true);
      if (this.versionKey(this.context()) === key) this.update();
    }).catch(() => {
      if (generation !== this.generation || this.destroyed || this.branchVersions.get(key) === true) return;
      this.branchVersions.set(key, false); this.failedVersionChecks.add(key);
      if (this.versionKey(this.context()) === key) this.update();
    }).finally(() => { if (generation === this.generation) this.versionChecks.delete(key); });
  }
  private update(): void {
    this.tree.hidden = !this.enabled; this.options.localTree.style.display = this.enabled ? "none" : "";
    this.toggle.disabled = !this.workspace; this.settings.disabled = !this.workspace;
    this.toggle.classList.toggle("is-on", this.enabled); this.toggle.setAttribute("aria-pressed", String(this.enabled));
    this.settings.setAttribute("aria-expanded", String(!!this.popup));
    const context = this.context(), key = this.versionKey(context);
    this.checkBranchVersion(context);
    if (this.visible && (!context?.repository.binding || (key !== null && this.branchVersions.get(key) === false))) this.leave();
    this.editorToggle.hidden = !this.ready(); this.editorToggle.classList.toggle("is-on", this.active); this.editorToggle.setAttribute("aria-pressed", String(this.active));
    this.host.hidden = !this.visible; this.tab.hidden = !this.visible;
    this.headings.hidden = !this.active;
    this.tabLabel.textContent = this.document ? this.document.context.path.split("/").pop()! + (this.document.model.getValue() !== this.document.saved ? " ●" : "") : "Collaborative file";
    this.tab.title = this.document?.file.diskPath ?? (this.document ? `${this.document.context.repository.binding?.branch}:${this.document.context.path}` : "Collaborative file");
  }

  private async toggleTree(): Promise<void> {
    const workspace = this.workspace; if (!workspace) return;
    const context = this.context();
    if (!(context ? context.repository.binding : this.repositories.some(repo => repo.binding))) { this.openSettings(); return; }
    this.toggle.disabled = true;
    try {
      const next = !this.enabled; await this.call({ op: "enable", enabled: next }, workspace);
      if (workspace !== this.workspace) return;
      this.enabled = next; this.closeSettings(); this.update(); this.renderTree();
    } catch (error) { this.error(error); }
    finally { if (workspace === this.workspace) this.toggle.disabled = false; }
  }
  private closeSettings(): void {
    this.syncSettings = null;
    if (this.repositoryDropdown) this.repositoryDropdown.disabled = true;
    this.repositoryDropdown = null; this.popup?.remove(); this.popup = null; this.settings.setAttribute("aria-expanded", "false");
  }
  private openSettings(autoScan = true): void {
    if (!this.workspace || this.destroyed) return;
    this.closeSettings();
    const popup = element("section", "devmode-build-menu collaborative-settings"); this.popup = popup; popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", "Repository settings");
    const header = element("div", "collaborative-settings-head", "Repository settings");
    const close = button("Close settings", () => this.closeSettings(), "devmode-panel-ghost is-icon collaborative-settings-close"); close.append(createLucideIcon(X, { size: 14 })); header.append(close);
    const status = element("div", "collaborative-settings-status", `${this.repositories.length} repositories detected`); status.setAttribute("role", "status");
    const repositoryOptions = () => this.repositories.map(repo => ({ value: repo.id, label: `${repo.name} · ${repo.kind.toUpperCase()}`, hint: repo.binding ? "" : "Not configured" }));
    const select = new AppDropdown(repositoryOptions(), this.context()?.repository.id ?? this.repositories[0]?.id ?? "", { className: "devmode-build-field", menuClassName: "collaborative-repository-menu", ariaLabel: "Repository" });
    select.disabled = !this.repositories.length; this.repositoryDropdown = select;
    const local = element("div", "collaborative-repository-root");
    const branch = document.createElement("input"); branch.setAttribute("aria-label", "Collaborative branch"); branch.spellcheck = false;
    let checkoutDirectory = "";
    let choosingDirectory = false, applying = false;
    const directory = button("Checkout directory", () => void chooseDirectory(), "app-dropdown-btn collaborative-checkout-picker");
    const directoryLabel = element("span", "collaborative-checkout-value");
    directory.append(createLucideIcon(FolderOpenFill, { size: 14 }), directoryLabel); directory.setAttribute("aria-haspopup", "dialog");
    const setDirectory = (path: string): void => {
      checkoutDirectory = path; directoryLabel.textContent = path || "Browse…";
      directory.title = path || "Choose checkout folder"; directory.classList.toggle("is-empty", !path);
    };
    const chooseDirectory = async (): Promise<void> => {
      const workspace = this.workspace, repositoryId = select.value;
      choosingDirectory = true; updateControls();
      try {
        if (!window.jellybot?.pickWorkspaceFolder) throw new Error("Folder chooser is unavailable");
        const picked = await window.jellybot.pickWorkspaceFolder();
        if (picked && this.popup === popup && this.workspace === workspace && select.value === repositoryId) setDirectory(picked);
      } catch (error) { if (this.popup === popup) this.error(error); }
      finally {
        choosingDirectory = false; if (this.popup === popup) updateControls();
      }
    };
    const field = (label: string, control: HTMLElement): HTMLElement => { const row = element("label", "", label); row.append(control); return row; };
    let populatedBranch = "", populatedDirectory = "";
    const populate = (): void => {
      const repo = this.repositories.find(r => r.id === select.value);
      local.textContent = repo?.root ?? "No repositories found"; branch.value = repo?.binding?.branch ?? "";
      branch.placeholder = repo?.kind === "svn" ? "SVN branch URL" : "origin/release";
      setDirectory(repo?.binding?.directory ?? ""); directory.disabled = !repo;
      populatedBranch = branch.value; populatedDirectory = checkoutDirectory;
    };
    select.addEventListener("change", populate); populate();
    const actions = element("div", "collaborative-settings-actions");
    const refreshRepositories = (): void => { void this.scanRepositories().catch(error => { if (this.popup === popup) this.error(error); }); };
    const rescan = button("Rescan", refreshRepositories, "devmode-commit-btn"); rescan.textContent = "Rescan";
    const apply = button("Apply", () => { void (async () => {
      const workspace = this.workspace; if (!workspace) return;
      applying = true; updateControls();
      try { const result = await this.call({ op: "bind", repositoryId: select.value, branch: branch.value, directory: checkoutDirectory }, workspace); if (workspace !== this.workspace) return; this.repositories = result.repositories ?? this.repositories; this.selection = null; this.closeSettings(); this.update(); await this.refreshTree(); }
      catch (error) { if (workspace === this.workspace) this.error(error); }
      finally { applying = false; if (this.popup === popup) updateControls(); }
    })(); }, "devmode-commit-btn is-primary action-primary"); apply.textContent = "Apply"; apply.disabled = !this.repositories.length;
    const updateControls = (): void => {
      const unavailable = !this.repositories.length || choosingDirectory || applying;
      select.disabled = unavailable; directory.disabled = unavailable;
      apply.disabled = unavailable || !!this.repositoryScan; rescan.disabled = !!this.repositoryScan || choosingDirectory || applying;
    };
    this.syncSettings = () => {
      const previous = select.value;
      const untouched = branch.value === populatedBranch && checkoutDirectory === populatedDirectory;
      select.update(repositoryOptions(), previous || this.context()?.repository.id);
      if (select.value !== previous || untouched) populate();
      else local.textContent = this.repositories.find(r => r.id === select.value)?.root ?? "No repositories found";
      status.textContent = this.repositoryScan ? "Scanning repositories…" : `${this.repositories.length} repositories detected`;
      updateControls();
    };
    actions.append(rescan, apply); popup.append(header, status, field("Repository", select.el), local, field("Branch", branch), field("Checkout", directory), actions); document.body.append(popup);
    const rect = this.settings.getBoundingClientRect(), width = popup.offsetWidth || 360;
    popup.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`; popup.style.top = `${Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - popup.offsetHeight - 8))}px`; this.update();
    this.syncSettings(); if (autoScan) refreshRepositories();
  }
  private renderTree(): void {
    this.body.replaceChildren(); if (!this.enabled) return;
    const row = (repo: CollaborativeRepository, path: string, name: string, directory: boolean, depth: number, materialized: boolean, modified: boolean, localOnly = false): HTMLElement => {
      const key = repo.id + ":" + path, opened = this.expanded.has(key);
      const localPath = norm(repo.root) + "/" + path;
      const branch = element("div", "devmode-tree-branch"), item = button(name, () => {
        if (!repo.binding) { this.openSettings(); return; }
        if (directory) { if (opened) this.expanded.delete(key); else { this.expanded.add(key); void this.list(repo, path); } this.renderTree(); }
        else if (localOnly) void this.options.area.openFile(localPath);
        else void this.openBranchFile({ repository: repo, path, localPath });
      }, `devmode-tree-row${directory ? " is-branch" : ""}${materialized || localOnly ? "" : " collaborative-virtual"}${!directory && ((this.selection?.repository.id === repo.id && this.selection.path === path) || (!this.selection && this.localPath && pathKey(this.localPath) === pathKey(localPath))) ? " is-selected" : ""}`);
      item.style.setProperty("--depth", String(depth)); if (directory) item.setAttribute("aria-expanded", String(opened));
      if (!directory && repo.binding) item.addEventListener("contextmenu", event => {
        event.preventDefault();
        const context = { repository: repo, path, localPath };
        const items: DevMenuItem[] = [{ label: "Commit…", onSelect: () => void this.openCommit(context) }];
        if (materialized) items.push({ label: "Release file", onSelect: () => void this.release(repo, path) });
        showDevMenu({ x: event.clientX, y: event.clientY }, items);
      });
      const inner = element("div", "devmode-tree-row-inner"), twist = element("div", "devmode-tree-tw"), icon = element("span", "devmode-tree-icon"), label = element("span", "devmode-tree-label", name);
      if (directory) twist.append(createLucideIcon(ChevronRight, { size: 12 }));
      icon.append(directory ? createLucideIcon(opened ? FolderOpenFill : FolderFill, { size: 14 }) : createLanguageIcon(languageForPath(path).icon, createLucideIcon));
      inner.append(twist, icon, label); item.append(inner);
      if (localOnly) item.append(element("span", "devmode-tree-st devmode-st-a", "A"));
      else if (modified) item.append(element("span", "devmode-tree-st devmode-st-m", "M"));
      if (!path) inner.append(element("span", "collaborative-repository-kind", repo.kind.toUpperCase()));
      branch.append(item);
      if (opened && directory) {
        const children = element("div", "devmode-tree-children"), entries = this.entries.get(key);
        if (!entries) children.append(element("div", "collaborative-tree-message", repo.binding ? "Loading…" : "Configure this repository first"));
        else for (const e of entries) children.append(row(repo, e.path, e.name, e.directory, depth + 1, e.materialized, e.modified, e.localOnly));
        branch.append(children);
      }
      return branch;
    };
    for (const repo of this.repositories) this.body.append(row(repo, "", repo.name, true, 0, repo.materialized.length > 0, false));
    if (!this.repositories.length) this.body.append(element("div", "collaborative-tree-message", "No repositories found. Open Repository settings to rescan."));
  }
  private async list(repo: CollaborativeRepository, path: string): Promise<void> {
    const key = repo.id + ":" + path, generation = this.generation, treeGeneration = this.treeGeneration, workspace = this.workspace;
    if (this.loading.has(key) || this.entries.has(key)) return;
    this.loading.add(key);
    try { const result = await this.call({ op: "list", repositoryId: repo.id, path, includeWorkingCopy: true }, workspace); if (generation !== this.generation || treeGeneration !== this.treeGeneration) return; this.entries.set(key, result.entries ?? []); this.renderTree(); }
    catch (error) { if (generation === this.generation && treeGeneration === this.treeGeneration) { this.expanded.delete(key); this.error(error); this.renderTree(); } }
    finally { if (generation === this.generation && treeGeneration === this.treeGeneration) this.loading.delete(key); }
  }
  private async refreshTree(): Promise<void> {
    const generation = this.generation;
    const expanded = [...this.expanded]; this.treeGeneration++; this.entries.clear(); this.loading.clear();
    for (const key of expanded) { const index = key.indexOf(":"), repo = this.repositories.find(r => r.id === key.slice(0, index)); if (repo?.binding) await this.list(repo, key.slice(index + 1)); }
    if (generation === this.generation) this.renderTree();
  }
  private async getDocument(context: Context): Promise<Document> {
    const key = this.workspace + "\0" + context.repository.id + ":" + context.path;
    const existing = this.documents.get(key);
    if (existing) {
      if (JSON.stringify(existing.context.repository.binding) !== JSON.stringify(context.repository.binding)) {
        if (existing.model.getValue() !== existing.saved) throw new Error("Branch binding changed while this file had unsaved edits. Preserve the draft before reopening.");
        const generation = this.generation, hash = existing.file.hash;
        const result = await this.call({ op: "read", repositoryId: context.repository.id, path: context.path }, existing.workspace);
        if (generation !== this.generation) throw new Error("Workspace changed");
        if (existing.file.hash !== hash || existing.model.getValue() !== existing.saved) throw new Error("Editor changed while reloading the branch. Reopen this file to retry.");
        existing.file = result.file!; existing.saved = existing.file.content; existing.model.setValue(existing.saved);
      }
      existing.context = context; return existing;
    }
    const pending = this.reading.get(key); if (pending) return pending;
    const read = this.readDocument(context, key);
    this.reading.set(key, read);
    try { return await read; } finally { if (this.reading.get(key) === read) this.reading.delete(key); }
  }
  private async readDocument(context: Context, key: string): Promise<Document> {
    const generation = this.generation, workspace = this.workspace!;
    const [api, result] = await Promise.all([this.options.area.prepareCollaborativeEditor(), this.call({ op: "read", repositoryId: context.repository.id, path: context.path }, workspace)]);
    if (generation !== this.generation || this.destroyed) throw new Error("Workspace changed");
    const file = result.file!;
    const version = this.versionKey(context); if (version) this.branchVersions.set(version, true);
    const uri = api.Uri.from({
      scheme: "collaborative",
      authority: context.repository.id,
      path: `/${encodeURIComponent(workspace)}/${context.path}`,
    });
    const model = api.editor.createModel(file.content, languageForPath(context.path).languageId, uri);
    const doc: Document = { workspace, context, file, saved: file.content, model, pending: null, saving: null, listener: { dispose() {} } };
    doc.listener = model.onDidChangeContent(() => {
      if (doc.file.binary || doc.model.getValue() === doc.saved) return;
      if (!doc.file.materialized && !doc.pending) {
        doc.pending = this.call({ op: "materialize", repositoryId: context.repository.id, path: context.path }, workspace).then(result => {
          doc.file = result.file!;
          if (!doc.context.repository.materialized.includes(context.path)) doc.context.repository.materialized.push(context.path);
          if (workspace === this.workspace) return this.refreshTree();
        }).catch(error => { if (workspace === this.workspace) this.error(error); }).finally(() => { doc.pending = null; if (workspace === this.workspace) this.update(); });
      }
      this.update();
    });
    this.documents.set(key, doc); return doc;
  }
  private async openBranchFile(context: Context): Promise<void> {
    const version = this.versionKey(context); if (version) this.branchVersions.set(version, true);
    let view = ++this.viewGeneration;
    const generation = this.generation, dual = this.active;
    try {
      if (!dual) {
        this.leave(); view = this.viewGeneration;
        this.selection = context; this.update(); this.renderTree();
        const local = this.options.area.collaborativeLocalDocument(context.localPath) || (await window.jellybot!.readFileForEditor(context.localPath)).ok;
        if (generation !== this.generation || view !== this.viewGeneration) return;
        if (local) {
          this.preparingLocalPath = context.localPath;
          try { await this.options.area.openFile(context.localPath); }
          finally { this.preparingLocalPath = null; }
          return;
        }
      }
      const doc = await this.getDocument(context);
      if (generation !== this.generation || view !== this.viewGeneration) return;
      this.selection = context; this.document = doc; this.active = dual; await this.showDocument(dual);
    }
    catch (error) { if (view === this.viewGeneration) this.error(error); }
  }
  private async toggleEditor(): Promise<void> {
    if (this.active) { this.leave(); return; }
    const context = this.context(); if (!context?.repository.binding || !this.ready()) return;
    if (this.editorToggle.classList.contains("is-running")) return;
    const view = ++this.viewGeneration;
    try { await withButtonLoading(this.editorToggle, async () => { const generation = this.generation; const doc = await this.getDocument(context); if (generation !== this.generation || view !== this.viewGeneration) return; this.document = doc; this.active = true; await this.showDocument(true); }); }
    catch (error) { if (view === this.viewGeneration) this.error(error); }
  }
  private async showDocument(dual: boolean): Promise<void> {
    const doc = this.document; if (!doc) return;
    const generation = this.generation, view = this.viewGeneration, api = await this.options.area.prepareCollaborativeEditor();
    if (generation !== this.generation || view !== this.viewGeneration || doc !== this.document) return;
    this.single?.dispose(); this.single = null; this.diffOverview?.dispose(); this.diffOverview = null; this.diff?.dispose(); this.diff = null; this.original?.dispose(); this.original = null; this.canvas.replaceChildren(); this.message.textContent = "";
    this.visible = true; this.options.area.showCollaborativeView(true); this.update(); this.renderTree();
    if (doc.file.binary) { this.message.textContent = "Binary, large or LFS file. File bodies are not downloaded in this view."; return; }
    const options = { automaticLayout: true, theme: resolveDevModeTheme(), ...getDevModeEditorFont(), scrollBeyondLastLine: false, minimap: { enabled: false }, scrollbar: { ...devModeEditorScrollbar } };
    if (!dual) this.single = api.editor.create(this.canvas, { ...options, model: doc.model, readOnly: true });
    else {
      let local = this.options.area.collaborativeLocalDocument(doc.context.localPath);
      if (local && pathKey(this.options.area.getActiveDocument()?.path ?? "") !== pathKey(doc.context.localPath)) {
        this.preparingLocalPath = doc.context.localPath;
        try { await this.options.area.openFile(doc.context.localPath); }
        finally { this.preparingLocalPath = null; }
        if (generation !== this.generation || view !== this.viewGeneration || doc !== this.document) return;
      }
      if (!local) {
        const result = await window.jellybot!.readFileForEditor(doc.context.localPath);
        if (generation !== this.generation || view !== this.viewGeneration || doc !== this.document) return;
        if (result.ok) {
          this.preparingLocalPath = doc.context.localPath;
          try { await this.options.area.openFile(doc.context.localPath); }
          finally { this.preparingLocalPath = null; }
          if (generation !== this.generation || view !== this.viewGeneration || doc !== this.document) return;
          local = this.options.area.collaborativeLocalDocument(doc.context.localPath);
        }
      }
      let original = local?.model;
      if (!original) { this.original = api.editor.createModel("", languageForPath(doc.context.path).languageId); original = this.original; }
      this.localHeading.textContent = "Working copy · " + doc.context.repository.name;
      this.targetHeading.textContent = "Collaborative · " + doc.context.repository.binding!.branch;
      this.targetHeading.title = this.targetHeading.textContent;
      this.diff = api.editor.createDiffEditor(this.canvas, { ...options, ...devModeDiffLayout, useInlineViewWhenSpaceIsLimited: false, renderOverviewRuler: false, originalEditable: !!local && !local.readOnly });
      this.diffOverview = bindDiffOverview(this.diff);
      this.diff.setModel({ original, modified: doc.model });
    }
    this.single?.focus(); this.diff?.getModifiedEditor().focus();
  }
  private leave(): void {
    this.viewGeneration++;
    this.active = false; this.visible = false; this.single?.dispose(); this.single = null; this.diffOverview?.dispose(); this.diffOverview = null; this.diff?.dispose(); this.diff = null; this.original?.dispose(); this.original = null;
    this.options.area.showCollaborativeView(false); this.host.hidden = true; this.tab.hidden = true; this.headings.hidden = true; this.editorToggle.classList.remove("is-on"); this.editorToggle.setAttribute("aria-pressed", "false");
  }
  private async saveDocument(doc: Document): Promise<void> {
    await doc.pending;
    await doc.saving;
    if (doc.model.getValue() === doc.saved) return;
    const content = doc.model.getValue();
    const saving = (async () => {
      const result = await this.call({ op: "save", repositoryId: doc.context.repository.id, path: doc.context.path, content, expectedHash: doc.file.hash }, doc.workspace);
      doc.file = result.file!; doc.saved = content; if (doc.workspace === this.workspace) this.update();
    })();
    doc.saving = saving;
    try { await saving; } finally { if (doc.saving === saving) doc.saving = null; }
  }
  openLocalCommit(path: string): boolean {
    const context = this.active ? this.contextForLocalPath(path) : null;
    if (!context?.repository.binding) return false;
    void this.openCommit(context);
    return true;
  }

  private async openCommit(context: Context): Promise<void> {
    const { repository, path, localPath } = context;
    const workspace = this.workspace, binding = repository.binding;
    if (!workspace || !binding || this.destroyed || this.commitSession) return;
    if (this.options.isChatBusy?.()) {
      void showAlert("Wait for the current turn to finish before committing.", {
        title: "Commit",
        type: "warning",
      });
      return;
    }

    const session = new AbortController();
    this.commitSession = session;
    const doc = this.documents.get(workspace + "\0" + repository.id + ":" + path);
    const docBinding = doc?.context.repository.binding;
    const branchDoc = docBinding?.branch === binding.branch && pathKey(docBinding.directory) === pathKey(binding.directory) ? doc : undefined;
    const readDrafts = (): Partial<Record<CollaborativeSide, CollaborativeEditorDraft>> => {
      const drafts: Partial<Record<CollaborativeSide, CollaborativeEditorDraft>> = {};
      const local = this.options.area.collaborativeLocalDocument(localPath);
      const left = local?.model.getValue(), right = branchDoc?.model.getValue();
      if (local && !local.readOnly && left !== undefined && left !== local.savedContent) {
        drafts.left = { content: left, savedContent: local.savedContent };
      }
      if (branchDoc && right !== undefined && right !== branchDoc.saved) {
        drafts.right = { content: right, savedContent: branchDoc.saved };
      }
      return drafts;
    };

    try {
      await branchDoc?.pending;
      await branchDoc?.saving;
      await openBranchCommitDialog({
        title: `Commit · ${repository.name} · ${repository.kind.toUpperCase()}`,
        signal: session.signal,
        request: request => this.call({ ...request, repositoryId: repository.id, path }, workspace),
        readDrafts,
        isChatBusy: () => this.options.isChatBusy?.() ?? false,
        onDraftSaved: (side, draft, result) => {
          if (side === "left") this.options.area.acceptCollaborativeLocalSave(localPath, draft.content);
          if (side === "right" && branchDoc && result.file) {
            branchDoc.file = result.file;
            branchDoc.saved = draft.content;
            this.update();
          }
        },
      });
    } catch (error) {
      if (!session.signal.aborted) this.error(error);
    } finally {
      if (this.commitSession === session) this.commitSession = null;
    }
  }

  private async release(repo: CollaborativeRepository, path: string): Promise<void> {
    const workspace = this.workspace, generation = this.generation;
    const docKey = workspace + "\0" + repo.id + ":" + path, doc = this.documents.get(docKey);
    try {
      await doc?.pending; await doc?.saving;
      const file = (await this.call({ op: "read", repositoryId: repo.id, path }, workspace)).file!;
      const modified = (await this.call({ op: "changes", repositoryId: repo.id }, workspace)).paths?.includes(path);
      if (generation !== this.generation) return;
      const dirty = !!modified || (!!doc && doc.model.getValue() !== doc.saved);
      if (dirty && !(await showConfirm(`Discard changes to ${path} and release its collaborative working file?`, { title: "Release file", confirmLabel: "Discard", destructive: true }))) return;
      if (generation !== this.generation) return;
      const result = await this.call({ op: "release", repositoryId: repo.id, path, expectedHash: file.hash, discard: dirty }, workspace);
      if (generation !== this.generation) return;
      if (this.document === doc) this.leave();
      if (doc) { doc.listener.dispose(); doc.model.dispose(); this.documents.delete(docKey); if (this.document === doc) this.document = null; }
      this.repositories = result.repositories ?? this.repositories;
      if (this.selection?.repository.id === repo.id) this.selection = null;
      this.update(); await this.refreshTree();
    } catch (error) { if (generation === this.generation) this.error(error); }
  }
  private saveFocused(): boolean {
    if (!this.visible || this.diff?.getOriginalEditor().hasTextFocus()) return false;
    const doc = this.document;
    if (doc) void this.saveDocument(doc).then(() => { if (doc.workspace === this.workspace) return this.refreshTree(); }).catch(error => this.error(error));
    return true;
  }
  private readonly outside = (event: PointerEvent): void => { if (this.popup && !this.popup.contains(event.target as Node) && !this.settings.contains(event.target as Node) && !this.repositoryDropdown?.ownsEvent(event)) this.closeSettings(); };
  private readonly escape = (event: KeyboardEvent): void => {
    if (!event.defaultPrevented && event.key === "Escape") this.closeSettings();
  };
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refresh().catch(error => this.error(error)); }, 80);
  }
  private async refresh(): Promise<void> {
    const workspace = this.workspace, generation = this.generation;
    if (!workspace || this.destroyed) return;
    await this.repositoryScan;
    if (generation !== this.generation || this.destroyed) return;
    const epoch = this.repositoryEpoch;
    const state = await this.call({ op: "state" }, workspace);
    if (generation !== this.generation || this.destroyed) return;
    if (epoch !== this.repositoryEpoch) { this.scheduleRefresh(); return; }
    for (const key of this.failedVersionChecks) this.branchVersions.delete(key);
    this.failedVersionChecks.clear();
    this.repositories = state.repositories ?? this.repositories; this.enabled = state.enabled === true;
    this.syncSettings?.();
    if (this.selection) {
      const repository = this.repositories.find(r => r.id === this.selection!.repository.id);
      this.selection = repository ? { ...this.selection, repository } : null;
    }
    this.update(); await this.refreshTree();
    const doc = this.document;
    if (doc?.workspace !== workspace || doc.pending || doc.saving || doc.model.getValue() !== doc.saved) return;
    const hash = doc.file.hash;
    const result = await this.call({ op: "read", repositoryId: doc.context.repository.id, path: doc.context.path }, workspace);
    if (generation !== this.generation || doc.file.hash !== hash || doc.pending || doc.saving || doc.model.getValue() !== doc.saved) return;
    doc.file = result.file!; doc.saved = doc.file.content;
    if (doc.model.getValue() !== doc.saved) doc.model.setValue(doc.saved);
    this.update();
  }
  private readonly focus = (): void => { if (this.workspace && (this.enabled || this.repositories.some(repo => !!repo.binding))) this.scheduleRefresh(); };
  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.hasUnsavedDrafts()) { event.preventDefault(); event.returnValue = ""; }
  };
  hasUnsavedDrafts(): boolean {
    return [...this.documents.values()].some(d => d.model.getValue() !== d.saved);
  }
  destroy(): void {
    this.destroyed = true; this.generation++; this.closeSettings(); this.leave();
    this.commitSession?.abort();
    dismissDevMenu();
    this.unsubscribe?.(); if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const doc of this.documents.values()) { doc.listener.dispose(); doc.model.dispose(); }
    this.documents.clear(); this.toggle.remove(); this.settings.remove(); this.editorToggle.remove(); this.tree.remove(); this.host.remove(); this.tab.remove();
    this.options.localTree.style.display = "";
    document.removeEventListener("pointerdown", this.outside, true); document.removeEventListener("keydown", this.escape); window.removeEventListener("focus", this.focus);
    window.removeEventListener("beforeunload", this.beforeUnload);
  }
}
