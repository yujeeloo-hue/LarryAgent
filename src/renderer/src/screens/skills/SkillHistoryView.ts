import { RotateCcw, X } from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import type { DiffLine } from "../conversation/cards/diffTypes.js";
import { createDiffLinedFileView } from "../conversation/cards/DiffLinedFileView.js";
import "../conversation/cards/content-cards.css";
import "./skill-dialog.css";
import "./skill-history.css";

export type SkillHistoryRow = {
  revision: number;
  current: boolean;
  /** e.g. "Revision 3" / "Live · revision 4". */
  title: string;
  /** e.g. "Replaced by Auto · 2d ago". */
  meta: string;
  reason?: string;
};

export type SkillHistoryDetail = {
  heading: string;
  /** Live → selected revision; null shows `message` instead. */
  diff: DiffLine[] | null;
  message?: string;
  canRestore: boolean;
};

/** Modal listing a skill's stored revisions with a diff against the live version. */
export class SkillHistoryView {
  readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly headingEl: HTMLElement;
  private readonly diffEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly restoreBtn: HTMLButtonElement;
  private canRestore = false;
  private busy = false;
  private onSelect: ((revision: number) => void) | null = null;
  private onRestore: (() => void) | null = null;
  private onClose: (() => void) | null = null;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.onClose?.();
    }
  };

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "skill-dialog-overlay";
    this.root.setAttribute("role", "presentation");
    this.root.addEventListener("click", (event) => {
      if (event.target === this.root) this.onClose?.();
    });

    const dialog = document.createElement("div");
    dialog.className = "skill-dialog skill-history-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "skill-history-title");

    const header = document.createElement("div");
    header.className = "skill-history-header";
    this.titleEl = document.createElement("h2");
    this.titleEl.id = "skill-history-title";
    this.titleEl.className = "skill-dialog-title";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "skill-history-close";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.append(createLucideIcon(X, { size: 14 }));
    closeBtn.addEventListener("click", () => this.onClose?.());
    header.append(this.titleEl, closeBtn);

    const layout = document.createElement("div");
    layout.className = "skill-history-layout";
    this.listEl = document.createElement("ul");
    this.listEl.className = "skill-history-list";
    this.listEl.setAttribute("role", "listbox");
    this.listEl.setAttribute("aria-label", "Revisions");

    const pane = document.createElement("div");
    pane.className = "skill-history-pane";
    const paneHeader = document.createElement("div");
    paneHeader.className = "skill-history-pane-header";
    this.headingEl = document.createElement("p");
    this.headingEl.className = "skill-history-heading";
    this.restoreBtn = document.createElement("button");
    this.restoreBtn.type = "button";
    this.restoreBtn.className = "skill-dialog-btn skill-dialog-btn-confirm action-primary skill-history-restore";
    this.restoreBtn.append(
      createLucideIcon(RotateCcw, { size: 14 }),
      document.createTextNode("Restore"),
    );
    this.restoreBtn.addEventListener("click", () => this.onRestore?.());
    paneHeader.append(this.headingEl, this.restoreBtn);
    this.diffEl = document.createElement("div");
    this.diffEl.className = "skill-history-diff";
    pane.append(paneHeader, this.diffEl);
    layout.append(this.listEl, pane);

    this.statusEl = document.createElement("p");
    this.statusEl.className = "skill-dialog-error";
    this.statusEl.hidden = true;

    dialog.append(header, layout, this.statusEl);
    this.root.append(dialog);
  }

  open(): void {
    document.body.append(this.root);
    window.addEventListener("keydown", this.onKeyDown);
  }

  close(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    this.root.remove();
  }

  setOnSelect(handler: ((revision: number) => void) | null): void {
    this.onSelect = handler;
  }

  setOnRestore(handler: (() => void) | null): void {
    this.onRestore = handler;
  }

  setOnClose(handler: (() => void) | null): void {
    this.onClose = handler;
  }

  setTitle(text: string): void {
    this.titleEl.textContent = text;
  }

  setRows(rows: SkillHistoryRow[], selected: number | null): void {
    this.listEl.replaceChildren();
    for (const row of rows) {
      const item = document.createElement("li");
      item.className = "skill-history-item";
      item.setAttribute("role", "option");
      item.tabIndex = 0;
      item.setAttribute("aria-selected", String(row.revision === selected));
      item.classList.toggle("is-selected", row.revision === selected);
      item.classList.toggle("is-current", row.current);
      const title = document.createElement("span");
      title.className = "skill-history-item-title";
      title.textContent = row.title;
      const meta = document.createElement("span");
      meta.className = "skill-history-item-meta";
      meta.textContent = row.meta;
      item.append(title, meta);
      if (row.reason) {
        const reason = document.createElement("span");
        reason.className = "skill-history-item-reason";
        reason.textContent = row.reason;
        reason.title = row.reason;
        item.append(reason);
      }
      const select = (): void => {
        if (!this.busy) this.onSelect?.(row.revision);
      };
      item.addEventListener("click", select);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
      this.listEl.append(item);
    }
  }

  setDetail(detail: SkillHistoryDetail): void {
    this.headingEl.textContent = detail.heading;
    this.canRestore = detail.canRestore;
    this.restoreBtn.hidden = !detail.canRestore;
    this.diffEl.replaceChildren();
    if (detail.diff) {
      this.diffEl.append(createDiffLinedFileView(detail.diff, { pathOrName: "SKILL.md", foldUnchanged: true }));
    } else {
      const message = document.createElement("p");
      message.className = "skill-history-empty";
      message.textContent = detail.message ?? "";
      this.diffEl.append(message);
    }
    this.setBusy(this.busy);
  }

  setStatus(message: string | null): void {
    this.statusEl.hidden = !message;
    this.statusEl.textContent = message ?? "";
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.setAttribute("aria-busy", String(busy));
    this.restoreBtn.disabled = busy || !this.canRestore;
  }
}
