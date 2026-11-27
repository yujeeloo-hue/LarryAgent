import { ChevronRight, Copy, Diff, GitBranch, GitCommitHorizontal, LoaderCircle } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { createLanguageIcon } from "../../../ui/languageIcons.js";
import { languageForPath } from "../../../devmode/languages.js";
import { claimDevModal } from "../../../devmode/modalLayer.js";
import "./gitPanel.css";

export type CommitPanelBusy = "generate" | "commit" | null;

export type CommitPanelFile = {
  id: string;
  path: string;
  status: WorkingTreeChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
  conflicted?: boolean;
  /** Selectable rows can be left out of the commit; static rows are informational. */
  selectable: boolean;
  checked: boolean;
  /** Reason a collab file cannot be committed (shown instead of the status). */
  note?: string;
  /** Where the working-tree diff for this row can be read from (repo root + relative path). */
  diff?: { root: string; path: string };
};

export type CommitPanelGroup = {
  id: string;
  /** Uppercase kind shown before the branch name, e.g. "Working copy". */
  kind: string;
  branch: string;
  files: CommitPanelFile[];
};

export type CommitPanelHandlers = {
  onCancel: () => void;
  onGenerate: () => void;
  onCommit: (message: string) => void;
  /** Double-clicking a file row opens its diff. */
  onOpenDiff?: (file: CommitPanelFile) => void;
};

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  untracked: "U",
  renamed: "R",
  copied: "C",
};

export function commitStatusLetter(status: string): string {
  return STATUS_LETTER[status] ?? "M";
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? "" : normalized.slice(0, cut);
}

function shortDirectory(path: string): string {
  const dir = directoryOf(path);
  return dir.length > 42 ? `…${dir.slice(-41)}` : dir;
}

function menuLabel(text: string): HTMLElement {
  const label = document.createElement("span");
  label.textContent = text;
  return label;
}

export class CommitPanelView {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly scopeEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly selectionEl: HTMLElement;
  private readonly selectAll: HTMLInputElement;
  private readonly selectionCount: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly generateBtn: HTMLButtonElement;
  private readonly generateLabel: HTMLElement;
  private readonly commitBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly spinner: SVGElement;
  private readonly handlers: CommitPanelHandlers;
  private readonly collapsed = new Set<string>();
  private readonly rows = new Map<string, { checkbox: HTMLInputElement; groupId: string; file: CommitPanelFile }>();
  private readonly groupCounts = new Map<string, HTMLElement>();
  private busy: CommitPanelBusy = null;
  private loading = false;
  private releaseModal: (() => void) | null = null;
  private ctxMenu: HTMLElement | null = null;
  private ctxCleanup: (() => void) | null = null;

  constructor(input: {
    title: string;
    groups: CommitPanelGroup[] | null;
    handlers: CommitPanelHandlers;
  }) {
    this.root = document.createElement("div");
    this.root.className = "git-panel-backdrop";
    this.handlers = input.handlers;

    this.panel = document.createElement("div");
    this.panel.className = "git-panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-label", input.title);

    const header = document.createElement("div");
    header.className = "git-panel-header";
    const headerIcon = createLucideIcon(GitCommitHorizontal, { size: 14 });
    headerIcon.classList.add("git-panel-header-icon");
    this.titleEl = document.createElement("span");
    this.titleEl.className = "git-panel-title";
    this.titleEl.textContent = input.title;
    this.scopeEl = document.createElement("span");
    this.scopeEl.className = "git-panel-scope";
    header.append(headerIcon, this.titleEl, this.scopeEl);

    this.listEl = document.createElement("div");
    this.listEl.className = "git-panel-list";
    const fileList = document.createElement("div");
    fileList.className = "git-panel-commit-list";
    this.selectionEl = document.createElement("div");
    this.selectionEl.className = "git-panel-select-all";
    const selectionLabel = document.createElement("label");
    this.selectAll = document.createElement("input");
    this.selectAll.type = "checkbox";
    this.selectAll.addEventListener("change", () => {
      if (this.selectAll.disabled) return;
      for (const { checkbox, file } of this.rows.values()) {
        checkbox.checked = this.selectAll.checked;
        file.checked = checkbox.checked;
      }
      this.syncCommitEnabled();
    });
    selectionLabel.append(this.selectAll, "Select all");
    this.selectionCount = document.createElement("span");
    this.selectionCount.className = "git-panel-selection-count";
    this.selectionCount.setAttribute("role", "status");
    this.selectionEl.append(selectionLabel, this.selectionCount);
    fileList.append(this.selectionEl, this.listEl);
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "git-panel-body";

    this.textarea = document.createElement("textarea");
    this.textarea.className = "git-panel-message";
    this.textarea.placeholder = "Describe the change — or AI Generate";
    this.textarea.setAttribute("aria-label", "Commit message");
    this.textarea.spellcheck = false;
    this.textarea.addEventListener("input", () => this.syncCommitEnabled());
    this.textarea.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.submit();
      }
    });

    this.statusEl = document.createElement("div");
    this.statusEl.className = "git-panel-status";
    this.statusEl.setAttribute("role", "status");

    const actions = document.createElement("div");
    actions.className = "git-panel-actions";

    this.generateBtn = document.createElement("button");
    this.generateBtn.type = "button";
    this.generateBtn.className = "git-panel-btn is-quiet";
    this.generateBtn.title = "Write the message with the model";
    this.spinner = createLucideIcon(LoaderCircle, { size: 13 });
    this.spinner.classList.add("is-spinner");
    this.spinner.style.display = "none";
    this.generateLabel = document.createElement("span");
    this.generateLabel.textContent = "AI Generate";
    this.generateBtn.append(this.spinner, this.generateLabel);
    this.generateBtn.addEventListener("click", () => {
      if (this.busy) return;
      input.handlers.onGenerate();
    });

    const spacer = document.createElement("div");
    spacer.className = "git-panel-spacer";

    this.cancelBtn = document.createElement("button");
    this.cancelBtn.type = "button";
    this.cancelBtn.className = "git-panel-btn";
    this.cancelBtn.textContent = "Cancel";
    this.cancelBtn.addEventListener("click", () => {
      if (this.busy === "commit") return;
      input.handlers.onCancel();
    });

    this.commitBtn = document.createElement("button");
    this.commitBtn.type = "button";
    this.commitBtn.className = "git-panel-btn is-primary git-panel-commit-btn";
    this.commitBtn.textContent = "Commit";
    this.commitBtn.addEventListener("click", () => this.submit());

    actions.append(this.generateBtn, spacer, this.cancelBtn, this.commitBtn);
    const footer = document.createElement("div");
    footer.className = "git-panel-footer";
    footer.append(this.statusEl, actions);
    this.bodyEl.append(fileList, this.textarea);
    this.panel.append(header, this.bodyEl, footer);
    this.root.append(this.panel);

    this.root.addEventListener("pointerdown", event => {
      if (event.target === this.root && this.busy !== "commit") input.handlers.onCancel();
    });
    this.root.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (this.ctxMenu) {
        this.closeFileMenu();
        return;
      }
      if (this.busy !== "commit") input.handlers.onCancel();
    });

    this.setGroups(input.groups);
  }

  mount(): void {
    this.releaseModal = claimDevModal();
    document.body.append(this.root);
    (this.textarea.hidden ? this.cancelBtn : this.textarea).focus();
  }

  destroy(): void {
    this.closeFileMenu();
    this.releaseModal?.();
    this.releaseModal = null;
    this.root.remove();
  }

  setTitle(title: string): void {
    this.titleEl.textContent = title;
    this.panel.setAttribute("aria-label", title);
  }

  getMessage(): string {
    return this.textarea.value.trim();
  }

  setMessage(message: string): void {
    this.textarea.value = message;
    this.syncCommitEnabled();
    this.textarea.focus();
    this.textarea.setSelectionRange?.(message.length, message.length);
  }

  setStatus(text: string | null, kind?: "error" | "ok"): void {
    this.statusEl.textContent = text ?? "";
    this.statusEl.classList.toggle("is-error", kind === "error");
    this.statusEl.classList.toggle("is-ok", kind === "ok");
  }

  showCommitting(): void {
    this.setStatus("Committing…");
    const spinner = createLucideIcon(LoaderCircle, { size: 12 });
    spinner.classList.add("is-spinner");
    this.statusEl.prepend(spinner);
  }

  setBusy(busy: CommitPanelBusy): void {
    this.busy = busy;
    this.generateBtn.classList.toggle("is-loading", busy === "generate");
    this.spinner.style.display = busy === "generate" ? "" : "none";
    this.generateLabel.textContent = busy === "generate" ? "Generating…" : "AI Generate";
    this.cancelBtn.disabled = busy === "commit";
    this.textarea.readOnly = busy !== null;
    this.syncCommitEnabled();
  }

  selectedIds(): string[] {
    return [...this.rows.entries()]
      .filter(([, row]) => row.checkbox.checked)
      .map(([id]) => id);
  }

  checkedCount(): number {
    return [...this.rows.values()].filter(row => row.checkbox.checked).length;
  }

  totalSelectable(): number {
    return this.rows.size;
  }

  setGroups(groups: CommitPanelGroup[] | null, emptyText = "Nothing to commit."): void {
    const wasLoading = this.loading;
    this.loading = groups === null;
    this.closeFileMenu();
    this.listEl.replaceChildren();
    this.rows.clear();
    this.groupCounts.clear();
    const visible = groups?.filter(group => group.files.length > 0) ?? [];
    this.listEl.classList.toggle("is-empty", visible.length === 0);
    this.listEl.classList.toggle("is-settled", !this.loading && visible.length === 0);
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "git-panel-empty";
      empty.setAttribute("role", "status");
      if (this.loading) {
        const spinner = createLucideIcon(LoaderCircle, { size: 12 });
        spinner.classList.add("is-spinner");
        empty.append(spinner, document.createTextNode("Reading changed files…"));
      } else {
        empty.textContent = emptyText;
      }
      this.listEl.append(empty);
    } else {
      for (const group of visible) this.listEl.append(this.renderGroup(group));
    }
    this.syncFormVisibility();
    this.syncCommitEnabled();
    if (wasLoading && !this.textarea.hidden && document.activeElement === this.cancelBtn) {
      this.textarea.focus();
    }
  }

  private syncFormVisibility(): void {
    const hasFiles = this.rows.size > 0;
    this.textarea.hidden = !hasFiles;
    this.generateBtn.hidden = !hasFiles;
    this.commitBtn.hidden = !hasFiles;
    this.cancelBtn.textContent = this.loading || hasFiles ? "Cancel" : "Close";
  }

  private renderGroup(group: CommitPanelGroup): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "git-panel-group";
    if (this.collapsed.has(group.id)) wrap.classList.add("is-collapsed");

    const head = document.createElement("button");
    head.type = "button";
    head.className = "git-panel-group-head";
    const chevron = document.createElement("span");
    chevron.className = "git-panel-chevron";
    if (!this.collapsed.has(group.id)) chevron.classList.add("is-open");
    chevron.append(createLucideIcon(ChevronRight, { size: 12 }));
    const kind = document.createElement("span");
    kind.className = "git-panel-group-kind";
    kind.textContent = group.kind;
    const branch = document.createElement("span");
    branch.className = "git-panel-group-branch";
    branch.textContent = group.branch;
    branch.title = group.branch;
    const count = document.createElement("span");
    count.className = "git-panel-group-count";
    this.groupCounts.set(group.id, count);
    head.append(chevron, createLucideIcon(GitBranch, { size: 12 }), kind, branch, count);
    head.addEventListener("click", () => {
      if (this.collapsed.has(group.id)) this.collapsed.delete(group.id);
      else this.collapsed.add(group.id);
      wrap.classList.toggle("is-collapsed", this.collapsed.has(group.id));
      chevron.classList.toggle("is-open", !this.collapsed.has(group.id));
    });

    const body = document.createElement("div");
    body.className = "git-panel-group-body";
    for (const file of group.files) body.append(this.renderFile(group, file));

    wrap.append(head, body);
    return wrap;
  }

  private renderFile(group: CommitPanelGroup, file: CommitPanelFile): HTMLElement {
    // Not a <label>: only the checkbox may change the selection, so a
    // double-click anywhere else on the row can open the diff.
    const row = document.createElement("div");
    row.className = "git-panel-file";
    if (!file.selectable) row.classList.add("is-static");
    if (file.status === "deleted") row.classList.add("is-deleted");
    if (this.handlers.onOpenDiff) row.classList.add("is-diffable");
    row.title = this.handlers.onOpenDiff
      ? `${file.path}\nRight-click or double-click to view the diff`
      : file.path;
    row.addEventListener("contextmenu", event => {
      if (!this.handlers.onOpenDiff) return;
      event.preventDefault();
      this.openFileMenu(file, event);
    });
    row.addEventListener("dblclick", event => {
      const handler = this.handlers.onOpenDiff;
      if (!handler) return;
      // Double-clicking the checkbox stays a checkbox gesture.
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".git-panel-check")) return;
      event.preventDefault();
      handler(file);
    });

    if (file.selectable) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "git-panel-check";
      checkbox.checked = file.checked;
      checkbox.setAttribute("aria-label", `Include ${baseName(file.path)}`);
      checkbox.addEventListener("change", () => {
        file.checked = checkbox.checked;
        this.syncCommitEnabled();
      });
      row.append(checkbox);
      this.rows.set(file.id, { checkbox, groupId: group.id, file });
    } else {
      const spacer = document.createElement("span");
      spacer.style.width = "12px";
      spacer.style.flex = "0 0 auto";
      row.append(spacer);
    }

    const lang = createLanguageIcon(languageForPath(file.path).icon);
    lang.classList.add("git-panel-lang");
    row.append(lang);

    const name = document.createElement("span");
    name.className = "git-panel-name";
    name.textContent = baseName(file.path);
    row.append(name);

    const dir = document.createElement("span");
    dir.className = "git-panel-dir";
    dir.textContent = shortDirectory(file.path);
    dir.title = directoryOf(file.path);
    row.append(dir);

    if (file.conflicted || file.note) {
      const note = document.createElement("span");
      note.className = "git-panel-note";
      note.textContent = file.conflicted ? "Conflict" : "Unavailable";
      note.title = file.note ?? "";
      row.append(note);
    } else {
      if (file.insertions > 0 || file.deletions > 0) {
        const stats = document.createElement("span");
        stats.className = "git-panel-stats";
        if (file.insertions > 0) {
          const add = document.createElement("span");
          add.className = "is-add";
          add.textContent = `+${file.insertions}`;
          stats.append(add);
        }
        if (file.deletions > 0) {
          const del = document.createElement("span");
          del.className = "is-del";
          del.textContent = `-${file.deletions}`;
          stats.append(del);
        }
        row.append(stats);
      }
      const badge = document.createElement("span");
      badge.className = `git-panel-st is-${file.status}`;
      badge.textContent = commitStatusLetter(file.status);
      row.append(badge);
    }

    return row;
  }

  private openFileMenu(file: CommitPanelFile, event: MouseEvent): void {
    this.closeFileMenu();
    const openDiff = this.handlers.onOpenDiff;
    if (!openDiff) return;

    const menu = document.createElement("div");
    menu.className = "git-panel-ctx-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "File actions");

    const diff = document.createElement("button");
    diff.type = "button";
    diff.className = "git-panel-ctx-item";
    diff.setAttribute("role", "menuitem");
    diff.append(createLucideIcon(Diff, { size: 13 }), menuLabel("View Diff"));
    if (!file.diff) {
      diff.disabled = true;
      diff.title = "No diff available";
    }
    diff.addEventListener("click", () => {
      if (diff.disabled) return;
      this.closeFileMenu();
      openDiff(file);
    });

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "git-panel-ctx-item";
    copy.setAttribute("role", "menuitem");
    copy.append(createLucideIcon(Copy, { size: 13 }), menuLabel("Copy Path"));
    copy.addEventListener("click", () => {
      this.closeFileMenu();
      try {
        void navigator.clipboard?.writeText(file.path);
      } catch {
      }
    });

    const sep = document.createElement("div");
    sep.className = "git-panel-ctx-sep";
    menu.append(diff, sep, copy);
    document.body.append(menu);
    this.ctxMenu = menu;

    const rect = menu.getBoundingClientRect();
    const x = Number.isFinite(event.clientX) ? event.clientX : 8;
    const y = Number.isFinite(event.clientY) ? event.clientY : 8;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;

    const onDown = (down: PointerEvent): void => {
      if (!menu.contains(down.target as Node)) this.closeFileMenu();
    };
    const onKey = (key: KeyboardEvent): void => {
      if (key.key === "Escape") this.closeFileMenu();
    };
    menu.addEventListener("pointerdown", down => down.stopPropagation(), true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    this.ctxCleanup = () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }

  private closeFileMenu(): void {
    this.ctxCleanup?.();
    this.ctxCleanup = null;
    this.ctxMenu?.remove();
    this.ctxMenu = null;
  }

  private submit(): void {
    if (this.commitBtn.disabled) return;
    const message = this.getMessage();
    if (!message) return;
    if (this.selectedIds().length === 0) return;
    this.handlers.onCommit(message);
  }

  private syncCommitEnabled(): void {
    const count = this.checkedCount();
    const total = this.totalSelectable();
    const busy = this.busy !== null;
    const canSelect = !this.loading && total > 0;
    this.selectionEl.hidden = !canSelect;
    this.selectAll.disabled = busy || !canSelect;
    this.selectAll.checked = total > 0 && count === total;
    this.selectAll.indeterminate = count > 0 && count < total;
    const selectionText = `${count} / ${total} selected`;
    if (this.selectionCount.textContent !== selectionText) {
      this.selectionCount.textContent = selectionText;
    }
    const groups = new Set(
      this.selectedIds()
        .map(id => this.rows.get(id)?.groupId)
        .filter((id): id is string => typeof id === "string"),
    );
    this.scopeEl.textContent = this.rows.size === 0
      ? ""
      : `${count} file${count === 1 ? "" : "s"} · ${groups.size} branch${groups.size === 1 ? "" : "es"}`;
    for (const [groupId, el] of this.groupCounts) {
      const files = [...this.rows.entries()].filter(([, row]) => row.groupId === groupId);
      const checked = files.filter(([, row]) => row.checkbox.checked).length;
      el.textContent = `${checked} / ${files.length} files`;
    }
    this.generateBtn.disabled = busy || count === 0;
    this.commitBtn.disabled = busy || count === 0 || !this.getMessage();
    for (const row of this.rows.values()) row.checkbox.disabled = busy;
  }
}
