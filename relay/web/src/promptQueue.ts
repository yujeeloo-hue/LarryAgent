import { el } from "./render.js";
import { icon } from "./icons.js";

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
  onPromote: (id: string) => void;
  onDefer: (id: string) => void;
};

const FOLD_MS = 240;

export class PromptQueueView {
  readonly root: HTMLElement;
  private items: PromptQueueItem[] = [];
  private handlers: PromptQueueHandlers | null = null;
  private editingId: string | null = null;
  private open = false;
  private hideTimer: number | null = null;
  private sessionIdle = false;

  constructor() {
    this.root = el("div", { class: "prompt-queue", "aria-label": "Queued messages" }) as HTMLElement;
    this.root.hidden = true;
    this.root.addEventListener("transitionend", (event) => {
      const e = event as TransitionEvent;
      if (e.target !== this.root) return;
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
    removeBtn.addEventListener("mousedown", (event) => event.preventDefault());
    actions.append(removeBtn);

    row.append(actions);
    return row;
  }

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
      if (typeof textarea.setSelectionRange === "function") {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    });
    return textarea;
  }

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
