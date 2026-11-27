import {
  createLucideIcon,
  GitCommitHorizontal,
  LoaderCircle,
  Sparkles,
} from "../ui/originalIcons.js";
import { claimDevModal } from "./modalLayer.js";
import type { CollaborativeCommitFile, CollaborativeSide } from "../../../shared/collaborative.js";
import { GitBranch } from "lucide";

export type CommitDialogHandlers = {
  onGenerate: () => void;
  onCommit: (message: string) => void;
  onCancel: () => void;
};

export type CommitDialogBusy = "generate" | "commit" | null;

const MAX_LISTED_FILES = 8;

export class CommitDialogView {
  readonly root: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly generateBtn: HTMLButtonElement;
  private readonly generateLabel: HTMLElement;
  private readonly commitBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly branchRows = new Map<CollaborativeSide, { checkbox: HTMLInputElement; status: HTMLElement; file: CollaborativeCommitFile; committed: boolean }>();
  private scopeCount: HTMLElement | null = null;
  private messageHeader: HTMLElement | null = null;
  private completed = false;
  private busy: CommitDialogBusy = null;
  private releaseModal: (() => void) | null = null;

  constructor(input: {
    title: string;
    files: string[];
    branchFiles?: CollaborativeCommitFile[];
    allowGenerate?: boolean;
    handlers: CommitDialogHandlers;
  }) {
    this.root = document.createElement("div");
    this.root.className = "devmode-commit-backdrop";

    const panel = document.createElement("div");
    panel.className = "devmode-commit";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", input.title);

    const header = document.createElement("div");
    header.className = "devmode-commit-header";
    const headerIcon = createLucideIcon(GitCommitHorizontal, { size: 14 });
    headerIcon.classList.add("devmode-commit-header-icon");
    this.titleEl = document.createElement("span");
    this.titleEl.className = "devmode-commit-title";
    this.titleEl.textContent = input.title;
    header.append(headerIcon, this.titleEl);

    const files = document.createElement("div");
    files.className = "devmode-commit-files";
    for (const path of input.files.slice(0, MAX_LISTED_FILES)) {
      const row = document.createElement("div");
      row.className = "devmode-commit-file";
      row.textContent = path;
      row.title = path;
      files.append(row);
    }
    if (input.files.length > MAX_LISTED_FILES) {
      const more = document.createElement("div");
      more.className = "devmode-commit-file is-more";
      more.textContent = `+${input.files.length - MAX_LISTED_FILES} more`;
      files.append(more);
    }
    if (input.branchFiles) {
      this.scopeCount = document.createElement("span");
      this.scopeCount.className = "devmode-commit-scope-count";
      header.append(this.scopeCount);
      files.classList.add("has-branches");
      for (const file of input.branchFiles) files.append(this.branchRow(file));
    }

    this.textarea = document.createElement("textarea");
    this.textarea.className = "devmode-commit-message";
    this.textarea.placeholder = "Commit message";
    this.textarea.setAttribute("aria-label", "Commit message");
    this.textarea.rows = 5;
    this.textarea.spellcheck = false;
    this.textarea.addEventListener("input", () => this.syncCommitEnabled());
    this.textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.submit(input.handlers);
      }
    });

    this.statusEl = document.createElement("div");
    this.statusEl.className = "devmode-commit-status";
    this.statusEl.setAttribute("role", "status");

    const actions = document.createElement("div");
    actions.className = "devmode-commit-actions";

    this.generateBtn = document.createElement("button");
    this.generateBtn.type = "button";
    this.generateBtn.className = "devmode-commit-btn is-generate";
    if (input.allowGenerate === false) this.generateBtn.style.display = "none";
    const generateIcon = createLucideIcon(Sparkles, { size: 13 });
    generateIcon.classList.add("devmode-commit-btn-icon");
    const spinner = createLucideIcon(LoaderCircle, { size: 13 });
    spinner.classList.add("devmode-commit-btn-icon", "is-spinner");
    this.generateLabel = document.createElement("span");
    this.generateLabel.textContent = "Generate";
    this.generateBtn.append(generateIcon, spinner, this.generateLabel);
    this.generateBtn.title = "Write the message with the model";
    this.generateBtn.addEventListener("click", () => {
      if (this.busy) return;
      input.handlers.onGenerate();
    });

    const spacer = document.createElement("div");
    spacer.className = "devmode-commit-spacer";

    this.cancelBtn = document.createElement("button");
    this.cancelBtn.type = "button";
    this.cancelBtn.className = "devmode-commit-btn";
    this.cancelBtn.textContent = "Cancel";
    this.cancelBtn.addEventListener("click", () => input.handlers.onCancel());

    this.commitBtn = document.createElement("button");
    this.commitBtn.type = "button";
    this.commitBtn.className = "devmode-commit-btn is-primary action-primary";
    this.commitBtn.textContent = "Commit";
    this.commitBtn.addEventListener("click", () => this.submit(input.handlers));

    actions.append(this.generateBtn, spacer, this.cancelBtn, this.commitBtn);
    panel.append(header, files);
    if (input.branchFiles) {
      this.messageHeader = document.createElement("div");
      this.messageHeader.className = "devmode-commit-message-header";
      const label = document.createElement("span");
      label.textContent = "Commit message";
      this.messageHeader.append(label, this.generateBtn);
      panel.append(this.messageHeader);
    }
    panel.append(this.textarea, this.statusEl, actions);
    this.root.append(panel);

    this.root.addEventListener("pointerdown", (event) => {
      if (event.target === this.root && this.busy !== "commit") input.handlers.onCancel();
    });
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (this.busy !== "commit") input.handlers.onCancel();
      }
    });

    this.syncCommitEnabled();
  }

  mount(): void {
    this.releaseModal = claimDevModal();
    document.body.append(this.root);
    this.textarea.focus();
  }

  destroy(): void {
    this.releaseModal?.();
    this.releaseModal = null;
    this.root.remove();
  }

  getMessage(): string {
    return this.textarea.value.trim();
  }

  setMessage(message: string): void {
    this.textarea.value = message;
    this.syncCommitEnabled();
    this.textarea.focus();
    this.textarea.setSelectionRange(message.length, message.length);
  }

  setStatus(text: string | null, kind?: "error" | "info"): void {
    this.statusEl.textContent = text ?? "";
    this.statusEl.classList.toggle("is-error", kind === "error");
  }

  setBusy(busy: CommitDialogBusy): void {
    this.busy = busy;
    this.root.classList.toggle("is-busy", busy !== null);
    this.generateBtn.classList.toggle("is-loading", busy === "generate");
    this.generateLabel.textContent =
      busy === "generate" ? "Generating…" : "Generate";
    this.cancelBtn.disabled = busy === "commit";
    this.textarea.readOnly = busy !== null;
    this.syncCommitEnabled();
  }

  selectedBranchFiles(): CollaborativeCommitFile[] {
    return [...this.branchRows.values()].filter(row => row.checkbox.checked && row.file.changed && !row.committed).map(row => row.file);
  }

  setBranchStatus(side: CollaborativeSide, status: string, committed = false): void {
    const row = this.branchRows.get(side);
    if (!row) return;
    row.committed = committed;
    row.status.textContent = status;
    row.status.classList.toggle("is-committed", committed);
    this.syncCommitEnabled();
  }

  refreshBranchFile(file: CollaborativeCommitFile): void {
    const row = this.branchRows.get(file.side);
    if (!row || row.committed) return;
    row.file = file;
    this.syncCommitEnabled();
  }

  finishBranches(): void {
    this.completed = true;
    this.setBusy(null);
    this.titleEl.textContent = this.titleEl.textContent!.replace(/^Commit\b/, "Committed");
    this.textarea.readOnly = true;
    this.cancelBtn.hidden = true;
    if (this.messageHeader) this.messageHeader.hidden = true;
    this.commitBtn.textContent = "Done";
    this.commitBtn.focus();
  }

  private branchRow(file: CollaborativeCommitFile): HTMLElement {
    const row = document.createElement("div");
    row.className = "devmode-commit-branch-file";
    const meta = document.createElement("div");
    meta.className = "devmode-commit-branch-meta";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = file.changed;
    checkbox.addEventListener("change", () => this.syncCommitEnabled());
    const side = file.side === "left" ? "Left" : "Right";
    const branch = document.createElement("span");
    branch.className = "devmode-commit-branch-name";
    branch.textContent = file.branch;
    branch.title = file.branch;
    label.append(checkbox, side, createLucideIcon(GitBranch, { size: 12 }), branch);
    const status = document.createElement("span");
    status.className = "devmode-commit-branch-status";
    status.textContent = file.unavailable ? "Unavailable" : file.added ? "Added" : file.changed ? "Modified" : "No changes";
    status.classList.toggle("is-modified", file.changed);
    status.classList.toggle("is-added", file.added === true);
    if (file.unavailable) status.title = file.unavailable;
    meta.append(label, status);
    const path = document.createElement("div");
    path.className = "devmode-commit-branch-path";
    path.textContent = file.diskPath;
    row.append(meta, path);
    if (file.unavailable) {
      const detail = document.createElement("div");
      detail.className = "devmode-commit-branch-path";
      detail.textContent = file.unavailable;
      row.append(detail);
    }
    this.branchRows.set(file.side, { checkbox, status, file, committed: false });
    return row;
  }

  private submit(handlers: CommitDialogHandlers): void {
    if (this.completed) { handlers.onCancel(); return; }
    if (this.commitBtn.disabled) return;
    const message = this.getMessage();
    if (!message) return;
    handlers.onCommit(message);
  }

  private syncCommitEnabled(): void {
    const count = this.selectedBranchFiles().length;
    if (this.scopeCount) {
      const total = this.completed ? [...this.branchRows.values()].filter(row => row.committed).length : count;
      this.scopeCount.textContent = total === 1 ? "1 file · 1 branch" : `${total} files · ${total} branches`;
      for (const row of this.branchRows.values()) row.checkbox.disabled = !!this.busy || !row.file.changed || row.committed || this.completed;
    }
    const emptyScope = this.scopeCount !== null && count === 0;
    this.generateBtn.disabled = !!this.busy || emptyScope;
    this.commitBtn.disabled = !this.completed && (!!this.busy || emptyScope || !this.getMessage());
  }
}
