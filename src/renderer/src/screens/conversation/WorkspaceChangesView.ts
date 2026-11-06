import {
  Columns2,
  Diff,
  FilePlus,
  FilePenLine,
  FolderSearch,
  RefreshCw,
  Trash2,
} from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import "./cards/content-cards.css";
import "./workspace-changes.css";

export type WorkspaceChangesFileRow = {
  path: string;
  name: string;
  status: WorkingTreeChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
};

const LIST_WIDTH_KEY = "workspace-changes-list-width";
const LIST_WIDTH_DEFAULT = 300;
const LIST_WIDTH_MIN = 200;
const LIST_WIDTH_MAX = 560;

/**
 * Changes window chrome — dirty file list + preview host.
 * Domain loading lives in WorkspaceChangesController.
 */
export class WorkspaceChangesView {
  readonly root: HTMLElement;
  readonly refreshButton: HTMLButtonElement;
  readonly compareButton: HTMLButtonElement;
  readonly revealButton: HTMLButtonElement;
  private readonly listSection: HTMLElement;
  private readonly listChrome: HTMLElement;
  private readonly previewChrome: HTMLElement;
  private readonly resizeHandle: HTMLElement;
  private readonly listHost: HTMLElement;
  private readonly previewTitleEl: HTMLElement;
  private readonly previewBody: HTMLElement;
  private selectHandler: ((path: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private refreshHandler: (() => void) | undefined;
  private compareHandler: (() => void) | undefined;
  private revealHandler: ((path: string) => void) | undefined;
  private revealLabel = "Reveal in Finder";
  private ctxMenu: HTMLElement | null = null;
  private ctxCleanup: (() => void) | null = null;
  private selectedPath = "";
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;
  private listWidth = LIST_WIDTH_DEFAULT;
  private resizeCleanup: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "workspace-changes-panel";
    this.root.setAttribute("role", "main");

    const columns = document.createElement("div");
    columns.className = "workspace-changes-columns";

    this.listSection = document.createElement("section");
    this.listSection.className =
      "workspace-changes-section workspace-changes-section-list";

    this.listChrome = document.createElement("div");
    this.listChrome.className =
      "workspace-changes-chrome workspace-changes-chrome-list";

    this.listHost = document.createElement("div");
    this.listHost.className = "workspace-changes-list";
    this.listSection.append(this.listChrome, this.listHost);

    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "workspace-changes-resize";
    this.resizeHandle.setAttribute("role", "separator");
    this.resizeHandle.setAttribute("aria-orientation", "vertical");
    this.resizeHandle.setAttribute("aria-label", "Resize panels");
    this.resizeHandle.title = "Drag to resize";
    this.resizeHandle.tabIndex = 0;

    const previewSection = document.createElement("section");
    previewSection.className =
      "workspace-changes-section workspace-changes-section-preview";

    this.previewChrome = document.createElement("div");
    this.previewChrome.className =
      "workspace-changes-chrome workspace-changes-chrome-preview";
    this.previewTitleEl = document.createElement("span");
    this.previewTitleEl.className = "workspace-changes-preview-filename";
    this.previewTitleEl.hidden = true;

    this.revealButton = document.createElement("button");
    this.revealButton.type = "button";
    this.revealButton.className = "workspace-changes-toolbar-btn";
    this.revealButton.title = "Reveal in Finder";
    this.revealButton.setAttribute("aria-label", "Reveal in Finder");
    this.revealButton.disabled = true;
    this.revealButton.append(createLucideIcon(FolderSearch, { size: 13 }));
    this.revealButton.addEventListener("click", () => {
      if (this.selectedPath) this.revealHandler?.(this.selectedPath);
    });

    this.compareButton = document.createElement("button");
    this.compareButton.type = "button";
    this.compareButton.className = "workspace-changes-toolbar-btn";
    this.compareButton.title = "Compare side by side";
    this.compareButton.setAttribute("aria-label", "Compare side by side");
    this.compareButton.setAttribute("aria-pressed", "false");
    this.compareButton.append(createLucideIcon(Columns2, { size: 13 }));
    this.compareButton.addEventListener("click", () => {
      this.compareHandler?.();
    });

    this.refreshButton = document.createElement("button");
    this.refreshButton.type = "button";
    this.refreshButton.className = "workspace-changes-toolbar-btn";
    this.refreshButton.title = "Refresh";
    this.refreshButton.setAttribute("aria-label", "Refresh");
    this.refreshButton.append(createLucideIcon(RefreshCw, { size: 13 }));
    this.refreshButton.addEventListener("click", () => {
      this.refreshHandler?.();
    });

    const previewActions = document.createElement("div");
    previewActions.className = "workspace-changes-chrome-actions";
    previewActions.append(this.revealButton, this.compareButton, this.refreshButton);

    this.previewChrome.append(this.previewTitleEl, previewActions);

    this.previewBody = document.createElement("div");
    this.previewBody.className = "workspace-changes-preview-body";
    const empty = document.createElement("p");
    empty.className = "workspace-changes-empty";
    empty.textContent = "Select a file to preview its diff.";
    this.previewBody.append(empty);
    previewSection.append(this.previewChrome, this.previewBody);

    columns.append(this.listSection, this.resizeHandle, previewSection);
    this.root.append(columns);

    this.listWidth = loadListWidth();
    this.applyListWidth(this.listWidth);
    this.bindResize();
  }

  onSelect(handler: (path: string) => void): void {
    this.selectHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onRefresh(handler: () => void): void {
    this.refreshHandler = handler;
  }

  onCompareToggle(handler: () => void): void {
    this.compareHandler = handler;
  }

  onReveal(handler: (path: string) => void): void {
    this.revealHandler = handler;
  }

  /** Platform-aware action label ("Reveal in Finder" / "Show in Explorer" /
   * "Show in Folder") — drives the toolbar tooltip and the row menu item. */
  setRevealLabel(label: string): void {
    this.revealLabel = label;
    this.revealButton.title = label;
    this.revealButton.setAttribute("aria-label", label);
  }

  setCompareActive(active: boolean): void {
    this.compareButton.classList.toggle("is-active", active);
    this.compareButton.setAttribute("aria-pressed", active ? "true" : "false");
    this.compareButton.title = active
      ? "Compare side by side (on)"
      : "Compare side by side";
  }

  mount(host: HTMLElement): void {
    host.replaceChildren(this.root);
    if (!this.keyHandler) {
      this.keyHandler = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          // Menu open → Escape dismisses the menu only (not the window).
          if (this.ctxMenu) {
            this.closeRowMenu();
            return;
          }
          this.closeHandler?.();
        }
      };
      window.addEventListener("keydown", this.keyHandler);
    }
  }

  /**
   * Windows-only chrome: brand (dog head + "Changes") at the left chrome's
   * leading edge, caption buttons flush right at the preview chrome's end.
   * Called only on win32 (native title bar hidden); macOS keeps the
   * traffic-light padding instead.
   */
  mountWindowsChrome(brand: HTMLElement, captionGroup: HTMLElement): void {
    brand.classList.add("workspace-changes-brand");
    this.listChrome.prepend(brand);
    this.previewChrome.append(captionGroup);
  }

  unmount(): void {
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.closeRowMenu();
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    this.root.remove();
  }

  setBusy(busy: boolean): void {
    this.refreshButton.disabled = busy;
    this.refreshButton.classList.toggle("is-busy", busy);
  }

  setFiles(files: WorkspaceChangesFileRow[], selectedPath: string): void {
    this.selectedPath = selectedPath;
    this.revealButton.disabled = !files.some((f) => f.path === selectedPath);
    this.closeRowMenu();

    this.listHost.replaceChildren();
    if (files.length === 0) {
      const empty = document.createElement("p");
      empty.className = "workspace-changes-empty";
      empty.textContent = "No changes.";
      this.listHost.append(empty);
      this.setPreviewTitle("");
      return;
    }

    for (const file of files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "workspace-changes-row";
      if (file.path === selectedPath) row.classList.add("is-selected");
      row.title = file.path;

      const icon = createLucideIcon(iconForStatus(file.status), { size: 14 });
      icon.classList.add("workspace-changes-row-icon");

      const meta = document.createElement("div");
      meta.className = "workspace-changes-row-meta";

      const titleRow = document.createElement("div");
      titleRow.className = "workspace-changes-row-title";

      const name = document.createElement("span");
      name.className = "workspace-changes-row-name";
      name.textContent = file.name;

      const badge = document.createElement("span");
      badge.className = `workspace-changes-badge is-${file.status}`;
      badge.textContent = statusLabel(file.status);

      titleRow.append(name, badge);

      if (!file.binary && (file.insertions > 0 || file.deletions > 0)) {
        const stats = document.createElement("span");
        stats.className = "workspace-changes-diff";
        if (file.insertions > 0) {
          const ins = document.createElement("span");
          ins.className = "workspace-changes-diff-ins";
          ins.textContent = `+${file.insertions}`;
          stats.append(ins);
        }
        if (file.deletions > 0) {
          const del = document.createElement("span");
          del.className = "workspace-changes-diff-del";
          del.textContent = `−${file.deletions}`;
          stats.append(del);
        }
        titleRow.append(stats);
      } else if (file.binary) {
        const binary = document.createElement("span");
        binary.className = "workspace-changes-badge";
        binary.textContent = "Binary";
        titleRow.append(binary);
      }

      const path = document.createElement("span");
      path.className = "workspace-changes-row-path";
      path.textContent = file.path;

      meta.append(titleRow, path);
      row.append(icon, meta);
      row.addEventListener("click", () => this.selectHandler?.(file.path));
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.openRowMenu(file.path, event);
      });
      this.listHost.append(row);
    }
  }

  /**
   * Right-click menu for a single dirty file: Reveal (platform label) and
   * Copy Relative Path. Body-mounted fixed popover, closed on outside
   * pointerdown or Escape (Escape must not bubble to the window-close
   * handler while the menu is open).
   */
  private openRowMenu(relativePath: string, event: MouseEvent): void {
    this.closeRowMenu();
    const menu = document.createElement("div");
    menu.className = "workspace-changes-ctx-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "File actions");

    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "workspace-changes-ctx-item";
    reveal.setAttribute("role", "menuitem");
    reveal.textContent = this.revealLabel;
    reveal.addEventListener("click", () => {
      this.closeRowMenu();
      this.revealHandler?.(relativePath);
    });

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "workspace-changes-ctx-item";
    copy.setAttribute("role", "menuitem");
    copy.textContent = "Copy Relative Path";
    copy.addEventListener("click", () => {
      this.closeRowMenu();
      try {
        void navigator.clipboard?.writeText(relativePath);
      } catch {
        // clipboard unavailable — no-op
      }
    });

    const sep = document.createElement("div");
    sep.className = "workspace-changes-ctx-sep";
    menu.append(reveal, sep, copy);
    document.body.append(menu);
    this.ctxMenu = menu;

    const x = Number.isFinite(event.clientX) ? event.clientX : 8;
    const y = Number.isFinite(event.clientY) ? event.clientY : 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;

    const onDown = (e: PointerEvent): void => {
      if (!menu.contains(e.target as Node)) this.closeRowMenu();
    };
    // Escape is handled centrally by the view's window keyHandler (menu
    // open → dismiss menu only), so no separate key listener here.
    menu.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    window.addEventListener("pointerdown", onDown, true);
    this.ctxCleanup = () => {
      window.removeEventListener("pointerdown", onDown, true);
    };
  }

  private closeRowMenu(): void {
    this.ctxCleanup?.();
    this.ctxCleanup = null;
    this.ctxMenu?.remove();
    this.ctxMenu = null;
  }

  setPreviewTitle(title: string): void {
    const trimmed = title.trim();
    if (!trimmed) {
      this.previewTitleEl.textContent = "";
      this.previewTitleEl.removeAttribute("title");
      this.previewTitleEl.hidden = true;
      return;
    }
    const base = fileName(trimmed);
    this.previewTitleEl.textContent = base;
    this.previewTitleEl.title = trimmed;
    this.previewTitleEl.hidden = false;
  }

  setPreviewLoading(): void {
    this.previewBody.replaceChildren();
    const status = document.createElement("p");
    status.className = "workspace-changes-empty";
    status.textContent = "Loading diff…";
    this.previewBody.append(status);
  }

  setPreviewMessage(message: string, isError = false): void {
    this.previewBody.replaceChildren();
    const status = document.createElement("p");
    status.className = `workspace-changes-empty${isError ? " is-error" : ""}`;
    status.textContent = message;
    this.previewBody.append(status);
  }

  setPreviewDiff(content: HTMLElement, notice?: string): void {
    this.previewBody.replaceChildren();
    if (notice) {
      const note = document.createElement("p");
      note.className = "workspace-changes-notice";
      note.textContent = notice;
      this.previewBody.append(note);
    }
    this.previewBody.append(content);
  }

  getSelectedPath(): string {
    return this.selectedPath;
  }

  private maxListWidth(): number {
    const room = Math.max(LIST_WIDTH_MIN, window.innerWidth - 280);
    return Math.min(LIST_WIDTH_MAX, room);
  }

  private applyListWidth(px: number): void {
    const max = this.maxListWidth();
    const clamped = Math.max(LIST_WIDTH_MIN, Math.min(max, px));
    this.listWidth = clamped;
    this.listSection.style.width = `${clamped}px`;
    this.listSection.style.flex = `0 0 ${clamped}px`;
    this.resizeHandle.setAttribute("aria-valuenow", String(Math.round(clamped)));
    this.resizeHandle.setAttribute("aria-valuemin", String(LIST_WIDTH_MIN));
    this.resizeHandle.setAttribute("aria-valuemax", String(max));
  }

  private setDragging(dragging: boolean): void {
    this.resizeHandle.classList.toggle("is-dragging", dragging);
    this.root.classList.toggle("is-resizing", dragging);
  }

  private bindResize(): void {
    let startX = 0;
    let startWidth = 0;
    let pointerId: number | null = null;

    const onPointerMove = (event: PointerEvent): void => {
      if (pointerId == null || event.pointerId !== pointerId) return;
      const next = startWidth + (event.clientX - startX);
      this.applyListWidth(next);
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (pointerId == null || event.pointerId !== pointerId) return;
      pointerId = null;
      this.setDragging(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      try {
        this.resizeHandle.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      saveListWidth(this.listWidth);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      pointerId = event.pointerId;
      startX = event.clientX;
      startWidth = this.listWidth;
      this.setDragging(true);
      this.resizeHandle.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? -16 : 16;
        this.applyListWidth(this.listWidth + delta);
        saveListWidth(this.listWidth);
      } else if (event.key === "Home") {
        event.preventDefault();
        this.applyListWidth(LIST_WIDTH_MIN);
        saveListWidth(this.listWidth);
      } else if (event.key === "End") {
        event.preventDefault();
        this.applyListWidth(LIST_WIDTH_MAX);
        saveListWidth(this.listWidth);
      }
    };

    const onDblClick = (): void => {
      this.applyListWidth(LIST_WIDTH_DEFAULT);
      saveListWidth(this.listWidth);
    };

    this.resizeHandle.addEventListener("pointerdown", onPointerDown);
    this.resizeHandle.addEventListener("keydown", onKeyDown);
    this.resizeHandle.addEventListener("dblclick", onDblClick);

    this.resizeCleanup = () => {
      this.resizeHandle.removeEventListener("pointerdown", onPointerDown);
      this.resizeHandle.removeEventListener("keydown", onKeyDown);
      this.resizeHandle.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function loadListWidth(): number {
  try {
    const raw = localStorage.getItem(LIST_WIDTH_KEY);
    if (!raw) return LIST_WIDTH_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return LIST_WIDTH_DEFAULT;
    return Math.max(LIST_WIDTH_MIN, Math.min(LIST_WIDTH_MAX, n));
  } catch {
    return LIST_WIDTH_DEFAULT;
  }
}

function saveListWidth(px: number): void {
  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(Math.round(px)));
  } catch {
    // ignore
  }
}

function iconForStatus(status: WorkingTreeChangeStatus) {
  if (status === "added" || status === "untracked") return FilePlus;
  if (status === "deleted") return Trash2;
  if (status === "renamed" || status === "copied") return Diff;
  return FilePenLine;
}

function statusLabel(status: WorkingTreeChangeStatus): string {
  switch (status) {
    case "untracked":
      return "Untracked";
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    default:
      return "Modified";
  }
}
