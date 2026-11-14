/**
 * Queued user prompts above the conversation composer — web port of the
 * desktop PromptQueueView (same structure, states and interactions).
 *
 * Presentation only — the device owns the queue and pushes a full snapshot
 * (`prompt_queue` stream event / every mutation reply). One compact zebra
 * table: a header row with the live count, then single-line rows (30px).
 * State encoding is a 2px left bar + colored icon/label; row actions overlay
 * the right-side state-label slot and crossfade in on hover/focus (always
 * visible on touch layouts via CSS).
 */
import { el } from "./render.js";
import { icon } from "./icons.js";

/**
 * `deferred` — waits for the whole turn to end, then starts a new turn.
 * `interrupt` — interrupts the running round, then inserts at its boundary.
 */
export type PromptQueueItemMode = "deferred" | "interrupt";

export type PromptQueueItem = {
  id: string;
  text: string;
  attachments: Array<{ name: string }>;
  mode: PromptQueueItemMode;
};

export type PromptQueueHandlers = {
  onRemove: (id: string) => void;
  onUpdateText: (id: string, text: string) => void;
  onMoveToFront: (id: string) => void;
  /** Insert now: arm for the next round boundary (or send when idle). */
  onPromote: (id: string) => void;
  /** Undo an arm — back to "after this turn". */
  onDefer: (id: string) => void;
};

/** Grid-fold open/close duration (matches the composer morph curve). */
const FOLD_MS = 240;

export class PromptQueueView {
  readonly root: HTMLElement;
  private items: PromptQueueItem[] = [];
  private handlers: PromptQueueHandlers | null = null;
  private editingId: string | null = null;
  private open = false;
  private hideTimer: number | null = null;
  /** No turn running → "Insert now" becomes "Send now". */
  private sessionIdle = false;

  constructor() {
    this.root = el("div", { class: "prompt-queue", "aria-label": "Queued messages" }) as HTMLElement;
    this.root.hidden = true;
    this.root.addEventListener("transitionend", (event) => {
      const e = event as TransitionEvent;
      if (e.target !== this.root) return;
      // The fold close (grid-template-rows) is the slowest property — hide
      // only after it lands so the collapse is never cut short.
      if (e.propertyName !== "grid-template-rows") return;
      if (this.open) return;
      this.finishHide();
    });
  }

  setHandlers(handlers: PromptQueueHandlers | null): void {
    this.handlers = handlers;
  }

  isOpen(): boolean {
    return this.open;
  }

  /**
   * Turn-running state drives the idle palette + button wording. Cheap enough
   * to re-render on change; only repaints while the queue is non-empty.
   */
  setSessionIdle(idle: boolean): void {
    if (this.sessionIdle === idle) return;
    this.sessionIdle = idle;
    this.root.classList.toggle("is-idle", idle);
    if (this.items.length > 0) this.render();
  }

  setItems(items: PromptQueueItem[]): void {
    const prevEditing = this.editingId;
    this.items = items.map((item) => ({
      id: item.id,
      text: item.text,
      attachments: item.attachments.map((a) => ({ ...a })),
      mode: item.mode,
    }));
    if (prevEditing && !this.items.some((item) => item.id === prevEditing)) {
      this.editingId = null;
    }
    this.render();
  }

  private render(): void {
    if (this.items.length === 0) {
      this.startHide();
      return;
    }
    this.mountList();
    this.startShow();
  }

  private mountList(): void {
    const rows = el("div", { class: "prompt-queue-rows" });
    this.items.forEach((item, index) => {
      rows.append(this.createItemEl(item, index));
    });
    const box = el("div", { class: "prompt-queue-box" }, this.createHeadEl(), rows);
    this.root.replaceChildren(el("div", { class: "prompt-queue-clip" }, box));
  }

  /** Header strip: icon + QUEUED label + live count + reach hint. */
  private createHeadEl(): HTMLElement {
    return el("div", { class: "prompt-queue-head" },
      el("span", { class: "prompt-queue-head-ico" }, icon("layers", 11)),
      el("span", {}, "Queued"),
      el("span", { class: "prompt-queue-head-count" }, `· ${this.items.length}`),
      el("span", { class: "prompt-queue-head-hint" },
        this.sessionIdle ? "send or edit below"
          : this.items.some((item) => item.mode === "interrupt")
            ? "interrupting this turn" : "sends after this turn"),
    );
  }

  private startShow(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.open = true;
    this.root.hidden = false;
    // Reflow so the enter transition starts from the folded state.
    void this.root.offsetWidth;
    this.root.classList.add("is-visible");
  }

  private startHide(): void {
    if (!this.open && this.root.hidden) {
      this.root.replaceChildren();
      return;
    }
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove("is-visible");
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.finishHide();
    }, FOLD_MS + 60);
  }

  private finishHide(): void {
    if (this.open) return;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private createItemEl(item: PromptQueueItem, index: number): HTMLElement {
    const editing = this.editingId === item.id;
    const row = el("div", {
      class: `prompt-queue-row${editing ? " is-editing" : ""}`,
      "data-id": item.id,
      "data-mode": item.mode,
    });

    if (editing) {
      row.append(this.createEditEl(item));
    } else {
      row.append(
        el("span", { class: "prompt-queue-row-ico" },
          icon(item.mode === "interrupt" ? "zap" : "hourglass", 12)),
      );

      const preview = el("button", {
        class: "prompt-queue-row-text",
        type: "button",
        title: "Click to edit",
        onclick: () => {
          this.editingId = item.id;
          this.render();
        },
      }, item.text.trim() || attachmentFallbackLabel(item)) as HTMLButtonElement;

      if (item.attachments.length > 0) {
        const att = el("span", {
          class: "prompt-queue-row-att",
          title: item.attachments.length === 1
            ? item.attachments[0]?.name ?? "Attachment"
            : `${item.attachments.length} attachments`,
        }, icon("paperclip", 10), el("span", {}, String(item.attachments.length)));
        row.append(preview, att);
      } else {
        row.append(preview);
      }

      const state = el("span", {
        class: "prompt-queue-row-state",
        ...(item.mode === "interrupt" ? { title: "Inserting now — active writes and pending answers finish first" } : {}),
      }, this.stateLabel(item));
      row.append(state);
    }

    const actions = el("div", { class: "prompt-queue-actions" });

    if (!editing) {
      // Insert now / Cancel insert — the only way into mid-turn insertion.
      if (item.mode === "interrupt") {
        actions.append(el("button", {
          class: "prompt-queue-action-btn is-promote is-armed",
          type: "button",
          "aria-label": "Cancel insert into this turn",
          title: "Cancel insert — wait for the turn to finish",
          onclick: () => this.handlers?.onDefer(item.id),
        }, icon("hourglass", 13)));
      } else {
        const sendNow = this.sessionIdle;
        actions.append(el("button", {
          class: "prompt-queue-action-btn is-promote",
          type: "button",
          "aria-label": sendNow ? "Send this message now" : "Insert into the running turn",
          title: sendNow ? "Send now" : "Insert into this turn (interrupt now)",
          onclick: () => this.handlers?.onPromote(item.id),
        }, icon(sendNow ? "cornerDownLeft" : "zap", 13)));
      }

      if (this.items.length > 1 && index > 0) {
        actions.append(el("button", {
          class: "prompt-queue-action-btn",
          type: "button",
          "aria-label": "Move to front of queue",
          title: "Move to front",
          onclick: () => this.handlers?.onMoveToFront(item.id),
        }, icon("arrowUpToLine", 13)));
      }

      actions.append(el("button", {
        class: "prompt-queue-action-btn",
        type: "button",
        "aria-label": "Edit queued message",
        title: "Edit",
        onclick: () => {
          this.editingId = item.id;
          this.render();
        },
      }, icon("pencil", 13)));
    }

    const removeBtn = el("button", {
      class: "prompt-queue-action-btn",
      type: "button",
      "aria-label": "Remove queued message",
      title: "Remove",
      onclick: () => {
        this.editingId = null;
        this.handlers?.onRemove(item.id);
      },
    }, icon("x", 13)) as HTMLButtonElement;
    // Avoid blur-commit racing remove when editing (desktop parity).
    removeBtn.addEventListener("mousedown", (event) => event.preventDefault());
    actions.append(removeBtn);

    row.append(actions);
    return row;
  }

  /** Inline editor for one row (the row grows while editing). */
  private createEditEl(item: PromptQueueItem): HTMLElement {
    const textarea = el("textarea", {
      class: "prompt-queue-edit",
      "aria-label": "Edit queued message",
    }) as HTMLTextAreaElement;
    textarea.value = item.text;
    textarea.rows = Math.min(4, Math.max(1, item.text.split("\n").length));
    textarea.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      if (e.key === "Escape") {
        e.preventDefault();
        this.editingId = null;
        this.render();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.commitEdit(item.id, textarea.value);
      }
    });
    textarea.addEventListener("blur", () => {
      if (this.editingId !== item.id) return;
      this.commitEdit(item.id, textarea.value);
    });
    queueMicrotask(() => {
      textarea.focus();
      // Guard: minimal DOM implementations (linkedom in tests) may not
      // implement selection APIs.
      if (typeof textarea.setSelectionRange === "function") {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    });
    return textarea;
  }

  /** One-line explanation of when this row will reach the agent. */
  private stateLabel(item: PromptQueueItem): string {
    if (item.mode === "interrupt") return "Now";
    return this.sessionIdle ? "Ready to send" : "After this turn";
  }

  private commitEdit(id: string, raw: string): void {
    this.editingId = null;
    const text = raw.trimEnd();
    this.handlers?.onUpdateText(id, text);
  }
}

function attachmentFallbackLabel(item: PromptQueueItem): string {
  if (item.attachments.length === 0) return "(empty)";
  if (item.attachments.length === 1) {
    return item.attachments[0]?.name ?? "Attachment";
  }
  return `${item.attachments.length} attachments`;
}

/** Map a device QueuedPrompt snapshot to view items. */
export function queuedPromptToViewItem(queued: {
  id: string;
  userText: string;
  attachments: Array<{ name: string }>;
  mode: string;
}): PromptQueueItem {
  return {
    id: queued.id,
    text: queued.userText,
    attachments: queued.attachments.map((a) => ({ name: a.name })),
    mode: queued.mode === "interrupt" || queued.mode === "steer" ? "interrupt" : "deferred",
  };
}
