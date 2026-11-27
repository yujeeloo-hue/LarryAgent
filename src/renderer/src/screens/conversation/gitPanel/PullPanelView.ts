import { ArrowDownToLine, Check, GitMerge, LoaderCircle, TriangleAlert } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { createLanguageIcon } from "../../../ui/languageIcons.js";
import { languageForPath } from "../../../devmode/languages.js";
import { claimDevModal } from "../../../devmode/modalLayer.js";
import { commitStatusLetter } from "./CommitPanelView.js";
import "./gitPanel.css";

export type PullChunk = "mine" | "theirs" | "both";

export type PullPanelMode = "loading" | "preview" | "merge" | "result" | "error" | "ai-starting" | "ai-started" | "ai-blocked";

export type PullPanelFile = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
};

export type PullPanelHandlers = {
  onCancel: () => void;
  onPull: () => void;
  onAbort: () => void;
  onApply: () => void;
  onResolveAi: () => void;
  onEnableCoco: () => void;
  onReviewConflicts: () => void;
  onRetryPreview?: () => void;
};

const CHIP_LABEL: Record<PullChunk, string> = {
  mine: "Keep mine",
  theirs: "Keep incoming",
  both: "Keep both",
};

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? "" : normalized.slice(0, cut);
}

export class PullPanelView {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly scopeEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly handlers: PullPanelHandlers;
  private readonly chipButtons = new Map<string, Map<PullChunk, HTMLButtonElement>>();
  private readonly chunks = new Map<string, PullChunk>();
  private readonly actionButtons = new Map<string, HTMLButtonElement>();
  private mode: PullPanelMode = "preview";
  private conflictCount = 0;
  private busy = false;
  private releaseModal: (() => void) | null = null;

  constructor(input: { handlers: PullPanelHandlers }) {
    this.handlers = input.handlers;
    this.root = document.createElement("div");
    this.root.className = "git-panel-backdrop";

    this.panel = document.createElement("div");
    this.panel.className = "git-panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-label", "Git Pull");

    const header = document.createElement("div");
    header.className = "git-panel-header";
    const icon = createLucideIcon(ArrowDownToLine, { size: 14 });
    icon.classList.add("git-panel-header-icon");
    this.titleEl = document.createElement("span");
    this.titleEl.className = "git-panel-title";
    this.titleEl.textContent = "Git Pull";
    this.scopeEl = document.createElement("span");
    this.scopeEl.className = "git-panel-scope";
    header.append(icon, this.titleEl, this.scopeEl);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "git-panel-body";

    this.statusEl = document.createElement("div");
    this.statusEl.className = "git-panel-status";
    this.statusEl.setAttribute("role", "status");

    this.actionsEl = document.createElement("div");
    this.actionsEl.className = "git-panel-actions";

    const footer = document.createElement("div");
    footer.className = "git-panel-footer";
    footer.append(this.statusEl, this.actionsEl);
    this.panel.append(header, this.bodyEl, footer);
    this.root.append(this.panel);

    this.root.addEventListener("pointerdown", event => {
      if (event.target === this.root && !this.busy) this.handlers.onCancel();
    });
    this.root.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!this.busy) this.handlers.onCancel();
    });
  }

  mount(): void {
    this.releaseModal = claimDevModal();
    document.body.append(this.root);
    this.focusAction();
  }

  destroy(): void {
    this.releaseModal?.();
    this.releaseModal = null;
    this.root.remove();
  }

  getMode(): PullPanelMode {
    return this.mode;
  }

  choices(): Map<string, PullChunk> {
    return new Map(this.chunks);
  }

  /** Files that still need a decision, in the order they were listed. */
  undecided(): string[] {
    return [...this.chipButtons.keys()].filter(path => !this.chunks.has(path));
  }

  setHeader(title: string, scope: string): void {
    this.titleEl.textContent = title;
    this.scopeEl.textContent = scope;
  }

  setStatus(text: string | null, kind?: "error" | "ok"): void {
    this.statusEl.replaceChildren();
    this.statusEl.classList.toggle("is-error", kind === "error");
    this.statusEl.classList.toggle("is-ok", kind === "ok");
    if (!text) return;
    if (kind === "error") this.statusEl.append(createLucideIcon(TriangleAlert, { size: 12 }));
    this.statusEl.append(document.createTextNode(text));
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    for (const button of this.actionButtons.values()) {
      button.disabled = busy || (button.dataset.needsChoice === "1" && this.chunks.size < this.conflictCount);
    }
    for (const chips of this.chipButtons.values()) {
      for (const chip of chips.values()) chip.disabled = busy;
    }
  }

  showLoading(): void {
    this.mode = "loading";
    this.scopeEl.textContent = "";
    this.setStatus(null);
    const { head, list } = this.section("Incoming files", "");
    list.classList.add("is-preview", "is-empty");
    const placeholder = document.createElement("div");
    placeholder.className = "git-panel-empty";
    placeholder.setAttribute("role", "status");
    const spinner = createLucideIcon(LoaderCircle, { size: 12 });
    spinner.classList.add("is-spinner");
    placeholder.append(spinner, document.createTextNode("Reading the pull preview…"));
    list.append(placeholder);
    this.bodyEl.replaceChildren(head, list);
    this.setActions([
      { id: "cancel", label: "Cancel", kind: "plain", onClick: this.handlers.onCancel },
    ]);
  }

  showPreviewError(message: string, retry = true): void {
    this.mode = "error";
    this.bodyEl.replaceChildren();
    this.setStatus(message, "error");
    this.setActions([
      { id: "close", label: "Close", kind: "plain", onClick: this.handlers.onCancel },
      ...(retry && this.handlers.onRetryPreview
        ? [{ id: "retry", label: "Retry", kind: "primary" as const, onClick: this.handlers.onRetryPreview }]
        : []),
    ]);
  }

  showPreview(files: PullPanelFile[], behind: number, ahead = 0): void {
    const scope = `${behind} behind · ${ahead} ahead`;
    if (files.length === 0 && behind === 0) {
      this.showDone("Already up to date.", scope);
      return;
    }
    this.mode = "preview";
    this.chipButtons.clear();
    this.chunks.clear();
    this.scopeEl.textContent = scope;
    this.setStatus(null);

    const section = this.section("Incoming files", `${files.length} file${files.length === 1 ? "" : "s"}`);
    section.list.classList.add("is-preview");
    if (files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "git-panel-empty";
      empty.textContent = "No file changes in the incoming commits.";
      section.list.classList.add("is-empty");
      section.list.append(empty);
    }
    for (const file of files) section.list.append(this.fileRow(file));
    this.bodyEl.replaceChildren(section.head, section.list);

    this.setActions([
      { id: "cancel", label: "Cancel", kind: "plain", onClick: this.handlers.onCancel },
      {
        id: "pull",
        label: "Pull",
        kind: "primary",
        onClick: this.handlers.onPull,
      },
    ]);
  }

  showMerge(conflicts: string[], incoming: PullPanelFile[]): void {
    this.mode = "merge";
    this.chipButtons.clear();
    this.bodyEl.replaceChildren();
    const conflictPaths = new Set(conflicts);
    for (const path of this.chunks.keys()) {
      if (!conflictPaths.has(path)) this.chunks.delete(path);
    }
    this.scopeEl.textContent = conflicts.length > 0 ? `${conflicts.length} conflicted` : "";
    this.conflictCount = conflicts.length;

    if (incoming.length > 0) {
      const incomingSection = this.section("Incoming changes", `${incoming.length} files`);
      incomingSection.list.classList.add("is-compact");
      this.bodyEl.append(incomingSection.head, incomingSection.list);
      for (const file of incoming) incomingSection.list.append(this.fileRow(file));
    }

    if (conflicts.length > 0) {
      const section = this.section("Conflicts", "Merge paused", true);
      this.bodyEl.append(section.head, section.list);
      for (const path of conflicts) section.list.append(this.conflictRow(path));
    }

    this.setActions([
      { id: "abort", label: "Abort merge", kind: "danger", onClick: this.handlers.onAbort },
      { id: "spacer" },
      ...(conflicts.length > 0
        ? [{ id: "resolve-ai", label: "Resolve with AI", kind: "accent" as const, onClick: this.handlers.onResolveAi }]
        : []),
      {
        id: "apply",
        label: "Apply & continue",
        kind: "primary",
        onClick: this.handlers.onApply,
        needsChoice: true,
      },
    ]);
    this.syncChoiceState();
  }

  showAi(input: {
    state: "starting" | "started" | "blocked";
    workspacePath: string;
    files: string[];
  }): void {
    this.mode =
      input.state === "blocked" ? "ai-blocked" : input.state === "started" ? "ai-started" : "ai-starting";
    this.bodyEl.replaceChildren();
    this.scopeEl.textContent = `${input.files.length} conflicted`;

    const off = input.state === "blocked";
    const card = document.createElement("div");
    card.className = `git-panel-ai${off ? " is-off" : ""}`;
    const iconWrap = document.createElement("span");
    iconWrap.className = "git-panel-ai-icon";
    iconWrap.append(createLucideIcon(GitMerge, { size: 16 }));

    const text = document.createElement("div");
    const title = document.createElement("div");
    title.className = "git-panel-ai-title";
    title.textContent = off
      ? "CoCo is turned off"
      : input.state === "started"
        ? "Task session started"
        : "Starting a task session…";
    const body = document.createElement("div");
    body.className = "git-panel-ai-body";
    body.append(document.createTextNode(
      off
        ? `Resolving ${input.files.length} conflicted file${input.files.length === 1 ? "" : "s"} with a task session needs CoCo. Turn it on, or fix them yourself in Dev Mode — nothing is lost, the merge stays paused.`
        : `Resolve the merge conflicts in `,
    ));
    if (!off) {
      const root = document.createElement("code");
      root.textContent = input.workspacePath;
      body.append(root);
      body.append(document.createTextNode(` — ${input.files.length} file${input.files.length === 1 ? "" : "s"}: `));
      const names = document.createElement("code");
      names.textContent = input.files.slice(0, 3).map(baseName).join(", ")
        + (input.files.length > 3 ? `, +${input.files.length - 3}` : "");
      body.append(names);
      body.append(document.createTextNode(
        ". Keep the local changes where they do not conflict with the incoming API surface, then leave the merge staged.",
      ));
      if (input.state === "started") {
        body.append(document.createElement("br"));
        body.append(document.createElement("br"));
        body.append(document.createTextNode(
          "The session is running. Apply & continue when it has finished.",
        ));
      }
    }
    text.append(title, body);
    card.append(iconWrap, text);
    this.bodyEl.append(card);

    if (off) {
      this.setStatus(
        `No session started — ${input.files.length} files still conflicted`,
        "error",
      );
      this.setActions([
        { id: "review", label: "Review conflicts", kind: "quiet", onClick: this.handlers.onReviewConflicts },
        { id: "spacer" },
        { id: "enable-coco", label: "Enable CoCo", kind: "accent", onClick: this.handlers.onEnableCoco },
      ]);
      return;
    }

    if (input.state === "started") {
      this.setStatus(`CoCo is resolving ${input.files.length} conflicted files`, "ok");
    } else {
      this.setStatus("Waiting for the session to accept the task…");
    }
    this.setActions([
      { id: "spacer" },
      { id: "close", label: "Close", kind: "quiet", onClick: this.handlers.onCancel },
    ]);
  }

  private section(title: string, count: string, danger = false): { head: HTMLElement; list: HTMLElement } {
    const head = document.createElement("div");
    head.className = `git-panel-section${danger ? " is-conflict" : ""}`;
    if (danger) head.append(createLucideIcon(TriangleAlert, { size: 11 }));
    head.append(document.createTextNode(title));
    const countEl = document.createElement("span");
    countEl.className = "git-panel-section-count";
    countEl.textContent = count;
    head.append(countEl);

    const list = document.createElement("div");
    list.className = "git-panel-list is-section";
    return { head, list };
  }

  private fileRow(file: PullPanelFile): HTMLElement {
    const row = document.createElement("div");
    row.className = "git-panel-file is-static";
    row.title = file.path;

    const spacer = document.createElement("span");
    spacer.style.width = "12px";
    spacer.style.flex = "0 0 auto";
    row.append(spacer);

    const lang = createLanguageIcon(languageForPath(file.path).icon);
    lang.classList.add("git-panel-lang");
    row.append(lang);

    const name = document.createElement("span");
    name.className = "git-panel-name";
    name.textContent = baseName(file.path);
    row.append(name);

    const dir = document.createElement("span");
    dir.className = "git-panel-dir";
    dir.textContent = directoryOf(file.path);
    dir.title = directoryOf(file.path);
    row.append(dir);

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
    return row;
  }

  private conflictRow(path: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "git-panel-conflict";

    const row = document.createElement("div");
    row.className = "git-panel-file is-static";
    row.title = path;

    const spacer = document.createElement("span");
    spacer.style.width = "12px";
    spacer.style.flex = "0 0 auto";
    row.append(spacer);

    const lang = createLanguageIcon(languageForPath(path).icon);
    lang.classList.add("git-panel-lang");
    row.append(lang);

    const name = document.createElement("span");
    name.className = "git-panel-name";
    name.textContent = baseName(path);
    row.append(name);

    const dir = document.createElement("span");
    dir.className = "git-panel-dir";
    dir.textContent = directoryOf(path);
    dir.title = directoryOf(path);
    row.append(dir);

    const badge = document.createElement("span");
    badge.className = "git-panel-st is-conflict";
    badge.textContent = "C";
    row.append(badge);

    const choices = document.createElement("div");
    choices.className = "git-panel-choices";
    const buttons = new Map<PullChunk, HTMLButtonElement>();
    for (const chunk of ["mine", "theirs", "both"] as PullChunk[]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "git-panel-chip";
      chip.textContent = CHIP_LABEL[chunk];
      chip.setAttribute("aria-pressed", String(this.chunks.get(path) === chunk));
      chip.addEventListener("click", () => {
        if (chip.disabled) return;
        this.chunks.set(path, chunk);
        for (const [value, button] of buttons) {
          button.setAttribute("aria-pressed", String(value === chunk));
        }
        this.syncChoiceState();
      });
      choices.append(chip);
      buttons.set(chunk, chip);
    }
    this.chipButtons.set(path, buttons);

    wrap.append(row, choices);
    return wrap;
  }

  private syncChoiceState(): void {
    const mine = [...this.chunks.values()].filter(value => value === "mine").length;
    const theirs = [...this.chunks.values()].filter(value => value === "theirs").length;
    const both = [...this.chunks.values()].filter(value => value === "both").length;
    const parts: string[] = [];
    if (mine) parts.push(`mine ×${mine}`);
    if (theirs) parts.push(`incoming ×${theirs}`);
    if (both) parts.push(`both ×${both}`);
    const remaining = this.conflictCount - this.chunks.size;
    if (remaining > 0) parts.push(`${remaining} undecided`);
    this.setStatus(
      parts.length === 0 ? "Merge ready to commit." : parts.join(" · "),
      remaining > 0 ? undefined : "ok",
    );
    const apply = this.actionButtons.get("apply");
    if (apply) apply.disabled = this.busy || remaining > 0;
    const resolve = this.actionButtons.get("resolve-ai");
    if (resolve) resolve.disabled = this.busy;
  }

  private setActions(
    actions: {
      id: string;
      label?: string;
      kind?: "plain" | "primary" | "quiet" | "accent" | "danger";
      onClick?: () => void;
      needsChoice?: boolean;
    }[],
  ): void {
    const restoreFocus = this.actionsEl.contains(document.activeElement);
    this.actionsEl.replaceChildren();
    this.actionButtons.clear();
    for (const action of actions) {
      if (!action.label || !action.onClick) {
        const spacer = document.createElement("div");
        spacer.className = "git-panel-spacer";
        this.actionsEl.append(spacer);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = `git-panel-btn${action.kind && action.kind !== "plain" ? ` is-${action.kind}` : ""}`;
      button.textContent = action.label;
      button.disabled = action.needsChoice === true && this.chunks.size < this.conflictCount;
      if (action.needsChoice) button.dataset.needsChoice = "1";
      button.addEventListener("click", () => {
        if (button.disabled) return;
        action.onClick?.();
      });
      this.actionButtons.set(action.id, button);
      this.actionsEl.append(button);
    }
    if (restoreFocus || !this.root.contains(document.activeElement)) this.focusAction();
  }

  private focusAction(): void {
    const primary = this.actionsEl.querySelector<HTMLButtonElement>(".is-primary:not(:disabled)");
    (primary ?? this.actionsEl.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
  }

  /** Status spinner used while a git command runs. */
  showWorking(text: string): void {
    this.setStatus(null);
    this.statusEl.append(createLucideIcon(LoaderCircle, { size: 12 }));
    const spinner = this.statusEl.querySelector("svg");
    spinner?.classList.add("is-spinner");
    this.statusEl.append(document.createTextNode(text));
  }

  showDone(text: string, scope = ""): void {
    this.mode = "result";
    this.scopeEl.textContent = scope;
    this.setStatus(null);
    const summary = document.createElement("div");
    summary.className = "git-panel-summary";
    summary.setAttribute("role", "status");
    const title = document.createElement("span");
    title.className = "git-panel-summary-title is-ok";
    title.append(createLucideIcon(Check, { size: 12 }), document.createTextNode(text));
    summary.append(title);
    this.bodyEl.replaceChildren(summary);
    this.setActions([
      { id: "close", label: "Close", kind: "plain", onClick: this.handlers.onCancel },
    ]);
  }
}
