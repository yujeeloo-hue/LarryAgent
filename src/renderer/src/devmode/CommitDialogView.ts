/**
 * Dev Mode commit dialog — presentation only.
 *
 * A modal over the workbench: the files going into the commit, a message
 * textarea the user fills in, and a Generate button that asks the model for a
 * draft. All git / LLM work lives in CommitDialogController.
 */
import {
  createLucideIcon,
  GitCommitHorizontal,
  LoaderCircle,
  Sparkles,
} from "../ui/originalIcons.js";
import { claimDevModal } from "./modalLayer.js";

export type CommitDialogHandlers = {
  onGenerate: () => void;
  onCommit: (message: string) => void;
  onCancel: () => void;
};

export type CommitDialogBusy = "generate" | "commit" | null;

/** Files listed in full up to this count; the rest collapse into "+N more". */
const MAX_LISTED_FILES = 8;

export class CommitDialogView {
  readonly root: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly generateBtn: HTMLButtonElement;
  private readonly generateLabel: HTMLElement;
  private readonly commitBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private busy: CommitDialogBusy = null;
  private releaseModal: (() => void) | null = null;

  constructor(input: {
    title: string;
    /** Workspace-relative paths going into the commit. */
    files: string[];
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
    const headerTitle = document.createElement("span");
    headerTitle.className = "devmode-commit-title";
    headerTitle.textContent = input.title;
    header.append(headerIcon, headerTitle);

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

    this.textarea = document.createElement("textarea");
    this.textarea.className = "devmode-commit-message";
    this.textarea.placeholder = "Commit message";
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

    const actions = document.createElement("div");
    actions.className = "devmode-commit-actions";

    this.generateBtn = document.createElement("button");
    this.generateBtn.type = "button";
    this.generateBtn.className = "devmode-commit-btn is-generate";
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
    panel.append(header, files, this.textarea, this.statusEl, actions);
    this.root.append(panel);

    this.root.addEventListener("pointerdown", (event) => {
      if (event.target === this.root) input.handlers.onCancel();
    });
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        input.handlers.onCancel();
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
    this.generateBtn.disabled = busy !== null;
    this.cancelBtn.disabled = busy === "commit";
    this.textarea.readOnly = busy !== null;
    this.syncCommitEnabled();
  }

  private submit(handlers: CommitDialogHandlers): void {
    if (this.busy) return;
    const message = this.getMessage();
    if (!message) return;
    handlers.onCommit(message);
  }

  private syncCommitEnabled(): void {
    this.commitBtn.disabled =
      this.busy !== null || this.textarea.value.trim().length === 0;
  }
}
