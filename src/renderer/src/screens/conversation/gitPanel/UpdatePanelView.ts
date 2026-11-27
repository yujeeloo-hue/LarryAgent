import {
  Check,
  LoaderCircle,
  RefreshCw,
  Square,
  TriangleAlert,
  type IconNode,
} from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { createLanguageIcon } from "../../../ui/languageIcons.js";
import { languageForPath } from "../../../devmode/languages.js";
import { claimDevModal } from "../../../devmode/modalLayer.js";
import "./gitPanel.css";

export type UpdateChunk = "mine" | "theirs" | "both" | "working";

/** A conflict row: SVN only lets a tree conflict keep the working copy. */
export type UpdateConflict = {
  path: string;
  kind: "text" | "tree";
};

export type UpdatePanelMode = "running" | "checking" | "conflicts" | "result" | "applied" | "stopped" | "error";

export type UpdateLogRow = {
  letter: string;
  path: string;
  bytes: number;
};

export type UpdatePanelHandlers = {
  onCancel: () => void;
  onStop: () => void;
  onResume: () => void;
  onApply: () => void;
  onCommit?: (() => void) | undefined;
};

const CHIP_LABEL: Record<UpdateChunk, string> = {
  mine: "Keep mine",
  theirs: "Keep incoming",
  both: "Keep both",
  working: "Keep files",
};

const CHIP_HINT: Partial<Record<UpdateChunk, string>> = {
  working: "Tree conflict — SVN cannot take one side, so the files stay as they are; merge them by hand.",
};

const CHIP_ORDER: Record<UpdateConflict["kind"], UpdateChunk[]> = {
  text: ["mine", "theirs", "both"],
  tree: ["working"],
};

const MAX_LOG_ROWS = 500;

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? "" : normalized.slice(0, cut);
}

export function formatUpdateBytes(bytes: number): string {
  if (bytes <= 0) return "";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatRate(bytes: number, elapsedMs: number): string {
  if (bytes <= 0 || elapsedMs <= 0) return "";
  const perSecond = (bytes / 1024 / 1024) * (1000 / elapsedMs);
  return `${perSecond < 10 ? perSecond.toFixed(1) : Math.round(perSecond)} MB/s`;
}

export class UpdatePanelView {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly scopeEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly handlers: UpdatePanelHandlers;
  private readonly chipButtons = new Map<string, Map<UpdateChunk, HTMLButtonElement>>();
  private readonly chunks = new Map<string, UpdateChunk>();
  private readonly resolved = new Set<string>();
  private readonly actionButtons = new Map<string, HTMLButtonElement>();
  private mode: UpdatePanelMode = "running";
  private conflictCount = 0;
  private busy = false;
  private releaseModal: (() => void) | null = null;
  private logList: HTMLElement | null = null;
  private logPlaceholder: HTMLElement | null = null;
  private progressTextEl: HTMLElement | null = null;

  constructor(input: { handlers: UpdatePanelHandlers }) {
    this.handlers = input.handlers;
    this.root = document.createElement("div");
    this.root.className = "git-panel-backdrop";

    this.panel = document.createElement("div");
    this.panel.className = "git-panel is-update";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-label", "SVN Update");

    const header = document.createElement("div");
    header.className = "git-panel-header";
    const icon = createLucideIcon(RefreshCw, { size: 14 });
    icon.classList.add("git-panel-header-icon");
    this.titleEl = document.createElement("span");
    this.titleEl.className = "git-panel-title";
    this.titleEl.textContent = "SVN Update";
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
      if (event.target === this.root && this.canClose()) this.handlers.onCancel();
    });
    this.root.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (this.canClose()) this.handlers.onCancel();
    });
  }

  mount(): void {
    this.releaseModal = claimDevModal();
    document.body.append(this.root);
    this.panel.querySelector<HTMLElement>(".git-panel-btn")?.focus();
  }

  destroy(): void {
    this.releaseModal?.();
    this.releaseModal = null;
    this.root.remove();
  }

  getMode(): UpdatePanelMode {
    return this.mode;
  }

  private canClose(): boolean {
    return !this.busy && this.mode !== "running";
  }

  choices(): Map<string, UpdateChunk> {
    return new Map(this.chunks);
  }

  undecided(): string[] {
    return [...this.chipButtons.keys()].filter(path => !this.chunks.has(path));
  }

  setScope(text: string): void {
    this.scopeEl.textContent = text;
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
      button.disabled =
        busy || (button.dataset.needsChoice === "1" && this.chunks.size < this.conflictCount);
    }
    for (const [path, chips] of this.chipButtons) {
      for (const chip of chips.values()) {
        chip.disabled = busy || this.mode === "applied" || this.resolved.has(path);
      }
    }
  }

  lockChoice(path: string): void {
    this.resolved.add(path);
    for (const chip of this.chipButtons.get(path)?.values() ?? []) {
      chip.disabled = true;
      chip.classList.toggle("is-static", chip.getAttribute("aria-pressed") === "true");
    }
  }

  showRunning(): void {
    this.mode = "running";
    this.chipButtons.clear();
    this.chunks.clear();
    this.resolved.clear();
    this.conflictCount = 0;
    this.bodyEl.replaceChildren();

    const { head, list, countEl } = this.section("Files", "");
    this.progressTextEl = countEl;
    list.classList.add("is-log", "is-preview", "is-empty");
    this.logList = list;

    this.logPlaceholder = document.createElement("div");
    this.logPlaceholder.className = "git-panel-empty";
    this.logPlaceholder.textContent = "Waiting for file changes…";
    list.append(this.logPlaceholder);

    this.bodyEl.append(head, list);
    this.setBusy(false);
    this.showWorking("Contacting the server…");
    this.setActions([
      { id: "spacer" },
      { id: "stop", label: "Stop", kind: "danger", onClick: this.handlers.onStop, icon: Square },
    ]);
    this.actionButtons.get("stop")?.focus();
  }

  appendLine(row: UpdateLogRow): void {
    if (!this.logList) return;
    if (this.logPlaceholder) {
      this.logPlaceholder.remove();
      this.logPlaceholder = null;
      this.logList.classList.remove("is-empty");
      if (!this.busy) this.showWorking("Updating working copy…");
    }
    this.logList.append(this.logRow(row));
    while (this.logList.childElementCount > MAX_LOG_ROWS) {
      this.logList.firstElementChild?.remove();
    }
    this.logList.scrollTop = this.logList.scrollHeight;
  }

  setProgress(input: { paths: number; bytes: number; elapsedMs: number }): void {
    if (!this.progressTextEl || input.paths === 0) return;
    const parts = [`${input.paths} path${input.paths === 1 ? "" : "s"}`];
    const size = formatUpdateBytes(input.bytes);
    if (size) parts.push(size);
    const rate = formatRate(input.bytes, input.elapsedMs);
    if (rate) parts.push(rate);
    this.progressTextEl.textContent = parts.join(" · ");
  }

  showCheckingConflicts(): void {
    this.mode = "checking";
    this.setBusy(false);
    this.setStatus("Checking for conflicts…");
    if (this.logPlaceholder) this.logPlaceholder.textContent = "No files changed.";
    this.setActions([
      { id: "spacer" },
      { id: "close", label: "Close", kind: "plain", onClick: this.handlers.onCancel },
    ]);
    this.actionButtons.get("close")?.focus();
  }

  showResult(input: {
    fromRevision: string | null;
    revision: string | null;
    alreadyCurrent: boolean;
    paths: number;
    bytes: number;
    conflicts?: UpdateConflict[];
    conflictError?: string;
  }): void {
    this.mode = "result";
    this.setScope(this.resultScope(input));
    const rows = this.takeLogRows();
    this.showSummary(
      input.alreadyCurrent
        ? (input.revision ? `Already at r${input.revision}` : "Already up to date")
        : input.revision
          ? `Updated to r${input.revision}`
          : "Updated",
      input.paths === 0 ? "No files changed." : `${input.paths} path${input.paths === 1 ? "" : "s"}`,
      formatUpdateBytes(input.bytes),
    );
    this.showFiles(rows, input.paths);
    this.setStatus(
      input.conflictError
        ? `Could not check for conflicts — ${input.conflictError}`
        : null,
      "error",
    );
    this.finishWith("done");
  }

  showConflicts(input: {
    fromRevision: string | null;
    revision: string | null;
    alreadyCurrent: boolean;
    paths: number;
    bytes: number;
    conflicts: UpdateConflict[];
  }): void {
    this.mode = "conflicts";
    this.chipButtons.clear();
    this.chunks.clear();
    this.resolved.clear();
    this.conflictCount = input.conflicts.length;
    const tree = input.conflicts.filter((entry) => entry.kind === "tree").length;
    this.setScope(
      [
        input.revision ? `r${input.revision}` : "Updated",
        `${input.conflicts.length} conflict${input.conflicts.length === 1 ? "" : "s"}`,
        ...(tree > 0 ? [`${tree} tree`] : []),
      ].join(" · "),
    );

    const kept = this.takeLogRows();
    this.bodyEl.replaceChildren();
    this.showFiles(kept, input.paths, true);

    const conflicts = this.section("Conflicts", "", true);
    this.bodyEl.append(conflicts.head, conflicts.list);
    for (const conflict of input.conflicts) conflicts.list.append(this.conflictRow(conflict));

    this.setBusy(false);
    this.setActions([
      { id: "spacer" },
      { id: "close", label: "Close", kind: "quiet", onClick: this.handlers.onCancel },
      {
        id: "apply",
        label: "Apply & close",
        kind: "primary",
        onClick: this.handlers.onApply,
        needsChoice: true,
      },
    ]);
    this.syncChoiceState();
    this.actionButtons.get("close")?.focus();
  }

  showApplied(input: { mine: number; theirs: number; both: number; working: number }): void {
    this.mode = "applied";
    const total = input.mine + input.theirs + input.both + input.working;
    const parts: string[] = [];
    if (input.mine) parts.push(`mine ×${input.mine}`);
    if (input.theirs) parts.push(`incoming ×${input.theirs}`);
    if (input.both) parts.push(`both ×${input.both}`);
    if (input.working) parts.push(`files ×${input.working}`);
    this.setStatus(
      total > 0 ? `Resolved ${total} conflict${total === 1 ? "" : "s"} — ${parts.join(" · ")}` : "No conflicts",
      "ok",
    );
    for (const chips of this.chipButtons.values()) {
      for (const chip of chips.values()) {
        chip.disabled = true;
        chip.classList.toggle("is-static", chip.getAttribute("aria-pressed") === "true");
      }
    }
    this.setActions([
      { id: "spacer" },
      { id: "close", label: "Close", kind: "quiet", onClick: this.handlers.onCancel },
      ...(this.handlers.onCommit
        ? [{ id: "commit", label: "Commit…", kind: "primary" as const, onClick: this.handlers.onCommit }]
        : []),
    ]);
    this.actionButtons.get("close")?.focus();
  }

  showStopped(input: { fromRevision: string | null; paths: number; bytes: number }): void {
    this.mode = "stopped";
    this.setScope(input.fromRevision ? `r${input.fromRevision}` : "");
    const rows = this.takeLogRows();
    this.showSummary(
      "Update stopped",
      input.paths === 0 ? "No files changed." : `${input.paths} path${input.paths === 1 ? "" : "s"} written`,
      formatUpdateBytes(input.bytes),
      Square,
    );
    this.showFiles(rows, input.paths);
    this.setStatus(null);
    this.finishWith("stopped");
  }

  showError(message: string): void {
    this.mode = "error";
    const rows = this.takeLogRows();
    this.bodyEl.replaceChildren();
    this.showFiles(rows);
    this.setStatus(message, "error");
    this.finishWith("stopped");
  }

  showWorking(text: string): void {
    this.setStatus(null);
    const spinner = createLucideIcon(LoaderCircle, { size: 12 });
    spinner.classList.add("is-spinner");
    this.statusEl.append(spinner, document.createTextNode(text));
  }

  private finishWith(kind: "done" | "stopped"): void {
    this.setBusy(false);
    this.setActions([
      { id: "spacer" },
      ...(kind === "stopped"
        ? [{
          id: "resume",
          label: this.mode === "error" ? "Retry" : "Resume",
          kind: "quiet" as const,
          onClick: this.handlers.onResume,
        }]
        : []),
      { id: "close", label: "Close", kind: "plain", onClick: this.handlers.onCancel },
    ]);
    this.actionsEl.querySelector<HTMLButtonElement>("button:last-child")?.focus();
  }

  private takeLogRows(): HTMLElement[] {
    if (!this.logList) return [];
    this.logPlaceholder?.remove();
    const nodes = [...this.logList.children] as HTMLElement[];
    this.logList = null;
    this.logPlaceholder = null;
    this.progressTextEl = null;
    return nodes;
  }

  private showFiles(rows: HTMLElement[], total = rows.length, compact = false): void {
    if (!rows.length) return;
    const count = total > rows.length ? `Last ${rows.length} of ${total}` : "";
    const { head, list } = this.section("Files", count);
    list.classList.add("is-log");
    if (compact) list.classList.add("is-compact");
    list.append(...rows);
    this.bodyEl.append(head, list);
  }

  private resultScope(input: {
    fromRevision: string | null;
    revision: string | null;
  }): string {
    if (input.revision && input.fromRevision && input.fromRevision !== input.revision) {
      return `r${input.fromRevision} → r${input.revision}`;
    }
    if (input.revision) return `r${input.revision}`;
    return "";
  }

  private showSummary(title: string, count: string, size = "", icon = Check): void {
    const summary = document.createElement("div");
    summary.className = "git-panel-summary";
    summary.setAttribute("role", "status");
    const main = document.createElement("div");
    main.className = "git-panel-summary-title";
    main.append(createLucideIcon(icon, { size: 12 }), document.createTextNode(title));
    if (icon === Check) main.classList.add("is-ok");
    const sub = document.createElement("div");
    sub.className = "git-panel-summary-meta";
    sub.textContent = size ? `${count} · ${size}` : count;
    summary.append(main, sub);
    this.bodyEl.replaceChildren();
    this.bodyEl.append(summary);
  }

  private section(
    title: string,
    count: string,
    danger = false,
  ): { head: HTMLElement; list: HTMLElement; countEl: HTMLElement } {
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
    return { head, list, countEl };
  }

  private logRow(row: UpdateLogRow): HTMLElement {
    const el = document.createElement("div");
    el.className = "git-panel-log-row";
    el.title = row.path;

    const letter = document.createElement("span");
    letter.className = `git-panel-log-letter is-${row.letter.toLowerCase()}`;
    letter.textContent = row.letter;
    el.append(letter);

    const name = document.createElement("span");
    name.className = "git-panel-name";
    name.textContent = baseName(row.path);
    el.append(name);

    const dir = document.createElement("span");
    dir.className = "git-panel-dir";
    dir.textContent = directoryOf(row.path);
    dir.title = directoryOf(row.path);
    el.append(dir);

    const size = formatUpdateBytes(row.bytes);
    if (size) {
      const sizeEl = document.createElement("span");
      sizeEl.className = "git-panel-log-size";
      sizeEl.textContent = size;
      el.append(sizeEl);
    }
    return el;
  }

  private conflictRow(conflict: UpdateConflict): HTMLElement {
    const path = conflict.path;
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
    const buttons = new Map<UpdateChunk, HTMLButtonElement>();
    for (const chunk of CHIP_ORDER[conflict.kind]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "git-panel-chip";
      chip.textContent = CHIP_LABEL[chunk];
      const hint = CHIP_HINT[chunk];
      if (hint) chip.title = hint;
      chip.setAttribute("aria-pressed", "false");
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
    const remaining = this.conflictCount - this.chunks.size;
    this.setStatus(
      remaining > 0
        ? `${remaining} undecided`
        : `All ${this.conflictCount} conflict${this.conflictCount === 1 ? "" : "s"} picked`,
      remaining > 0 ? undefined : "ok",
    );
    const apply = this.actionButtons.get("apply");
    if (apply) apply.disabled = this.busy || remaining > 0;
  }

  private setActions(
    actions: {
      id: string;
      label?: string;
      kind?: "plain" | "primary" | "quiet" | "accent" | "danger";
      onClick?: () => void;
      disabled?: boolean;
      needsChoice?: boolean;
      icon?: IconNode;
    }[],
  ): void {
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
      if (action.icon) {
        button.append(createLucideIcon(action.icon, { size: 12 }));
        button.classList.add("has-icon");
      }
      button.append(document.createTextNode(action.label));
      button.disabled = !!action.disabled;
      if (action.needsChoice) button.dataset.needsChoice = "1";
      button.addEventListener("click", () => {
        if (button.disabled) return;
        action.onClick?.();
      });
      this.actionButtons.set(action.id, button);
      this.actionsEl.append(button);
    }
  }
}
