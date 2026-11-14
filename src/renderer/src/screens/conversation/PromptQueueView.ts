import {
  ArrowUpToLine,
  ChevronDown,
  CornerDownLeft,
  CornerDownRight,
  Hourglass,
  Paperclip,
  Pencil,
  X,
  Zap,
} from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import { createFunctionalIcon } from "../../ui/icons.js";
import type { PendingAttachment } from "../../ui/taskComposer/bindComposerAttachments.js";
import { isImeComposing } from "../../ui/ime.js";
import "./prompt-queue.css";

/**
 * `deferred` — waits for the whole turn to end, then starts a new turn.
 * `interrupt` — inserts at the next natural boundary in the running turn.
 */
export type PromptQueueItemMode = "deferred" | "interrupt";

export type PromptQueueItem = {
  id: string;
  text: string;
  attachments: PendingAttachment[];
  mode: PromptQueueItemMode;
};

export type PromptQueueHandlers = {
  onRemove: (id: string) => void;
  onUpdateText: (id: string, text: string) => void;
  onMoveToFront: (id: string) => void;
  /** Insert into this turn at the next natural boundary (or send when idle). */
  onPromote: (id: string) => void;
  /** Undo an arm — back to "after this turn". */
  onDefer: (id: string) => void;
};

/** Grid-fold open/close duration (matches the composer morph curve). */
const FOLD_MS = 240;
let queueInstance = 0;

/**
 * Queued user prompts inside the conversation composer's shared frame.
 *
 * Presentation only — the main process owns the queue and pushes a full
 * snapshot after every mutation. The count remains visible when collapsed;
 * the preview shows the next message. Only explicit actions change when a
 * queued message reaches the agent.
 */
export class PromptQueueView {
  readonly root: HTMLElement;
  private items: PromptQueueItem[] = [];
  private handlers: PromptQueueHandlers | null = null;
  private editingId: string | null = null;
  private open = false;
  private collapsed = false;
  private readonly rowsId = `prompt-queue-rows-${++queueInstance}`;
  private readonly rowsResizeObserver: ResizeObserver | null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private onOpenChange: ((open: boolean) => void) | null = null;
  /** No turn running → "Insert into this turn" becomes "Send now". */
  private sessionIdle = false;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "prompt-queue";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Queued messages");
    this.rowsResizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => {
      if (!entry) return;
      const rows = entry.target as HTMLElement;
      this.root.style.setProperty("--prompt-queue-scrollbar-width", `${rows.offsetWidth - rows.clientWidth}px`);
    });
    this.root.addEventListener("transitionend", (event) => {
      if (event.target !== this.root) return;
      // The fold close (grid-template-rows) is the slowest property — hide
      // only after it lands so the collapse is never cut short.
      if (event.propertyName !== "grid-template-rows") return;
      if (this.open) return;
      this.finishHide();
    });
  }

  setOnOpenChange(handler: ((open: boolean) => void) | null): void {
    this.onOpenChange = handler;
  }

  setHandlers(handlers: PromptQueueHandlers | null): void {
    this.handlers = handlers;
  }

  destroy(): void {
    this.rowsResizeObserver?.disconnect();
    if (this.hideTimer != null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.open = false;
    this.handlers = null;
    this.onOpenChange = null;
    this.root.replaceChildren();
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
    if (this.items.length === 0 && items.length > 0) this.collapsed = false;
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
    this.rowsResizeObserver?.disconnect();
    this.root.classList.toggle("is-collapsed", this.collapsed);
    const clip = document.createElement("div");
    clip.className = "prompt-queue-clip";

    const box = document.createElement("div");
    box.className = "prompt-queue-box";
    box.append(this.createHeadEl());

    const list = document.createElement("div");
    list.className = "prompt-queue-list";
    list.id = this.rowsId;
    list.inert = this.collapsed;
    list.setAttribute("aria-hidden", String(this.collapsed));
    const rows = document.createElement("div");
    rows.className = "prompt-queue-rows";
    this.items.forEach((item, index) => {
      rows.append(this.createItemEl(item, index));
    });
    list.append(rows);
    box.append(list);

    const next = document.createElement("div");
    next.className = "prompt-queue-next";
    next.hidden = !this.collapsed;
    next.append(createLucideIcon(CornerDownRight, { size: 12 }));
    const preview = document.createElement("span");
    const first = this.items[0];
    preview.textContent = first
      ? first.text.trim() || attachmentFallbackLabel(first)
      : "";
    preview.title = preview.textContent;
    next.append(preview);
    box.append(next);

    clip.append(box);
    this.root.replaceChildren(clip);
    this.rowsResizeObserver?.observe(rows);
  }

  /** Header strip: icon + QUEUED label + live count + reach hint. */
  private createHeadEl(): HTMLElement {
    const head = document.createElement("div");
    head.className = "prompt-queue-head";
    head.append(createFunctionalIcon("Layers2", 14));
    const label = document.createElement("span");
    label.textContent = "Queued";
    head.append(label);
    const count = document.createElement("span");
    count.className = "prompt-queue-head-count";
    count.textContent = `· ${this.items.length}`;
    head.append(count);
    const hint = document.createElement("span");
    hint.className = "prompt-queue-head-hint";
    hint.textContent = this.sessionIdle
      ? "send or edit below"
      : this.items.some((item) => item.mode === "interrupt")
        ? "inserts after the current step"
        : "sends after this turn";
    head.append(hint);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "prompt-queue-action-btn prompt-queue-toggle";
    toggle.setAttribute("aria-expanded", String(!this.collapsed));
    toggle.setAttribute("aria-controls", this.rowsId);
    toggle.setAttribute("aria-label", this.collapsed ? "Expand queued messages" : "Collapse queued messages");
    toggle.title = this.collapsed ? "Expand queue" : "Collapse queue";
    toggle.append(createLucideIcon(ChevronDown, { size: 14 }));
    // Keep inline editing from blur-committing before the toggle click lands.
    toggle.addEventListener("mousedown", (event) => event.preventDefault());
    toggle.addEventListener("click", () => {
      this.setCollapsed(!this.collapsed);
      this.root.querySelector<HTMLButtonElement>(".prompt-queue-toggle")?.focus();
    });
    head.append(toggle);
    return head;
  }

  private setCollapsed(collapsed: boolean): void {
    if (collapsed && this.editingId) {
      const editor = this.root.querySelector<HTMLTextAreaElement>(".prompt-queue-edit");
      if (editor) this.commitEdit(this.editingId, editor.value);
      this.mountList();
    }
    this.collapsed = collapsed;
    this.root.classList.toggle("is-collapsed", collapsed);
    const list = this.root.querySelector<HTMLElement>(".prompt-queue-list");
    if (list) {
      list.inert = collapsed;
      list.setAttribute("aria-hidden", String(collapsed));
    }
    const next = this.root.querySelector<HTMLElement>(".prompt-queue-next");
    if (next) next.hidden = !collapsed;
    const toggle = this.root.querySelector<HTMLButtonElement>(".prompt-queue-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", collapsed ? "Expand queued messages" : "Collapse queued messages");
      toggle.title = collapsed ? "Expand queue" : "Collapse queue";
    }
  }

  private startShow(): void {
    if (this.hideTimer != null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const wasOpen = this.open;
    this.open = true;
    this.root.hidden = false;
    // Reflow so the enter transition starts from the folded state.
    void this.root.offsetWidth;
    this.root.classList.add("is-visible");
    if (!wasOpen) {
      this.onOpenChange?.(true);
    }
  }

  private startHide(): void {
    if (!this.open && this.root.hidden) {
      this.root.replaceChildren();
      return;
    }
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove("is-visible");
    this.onOpenChange?.(false);
    if (this.hideTimer != null) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.finishHide();
    }, FOLD_MS + 60);
  }

  private finishHide(): void {
    if (this.open) return;
    this.rowsResizeObserver?.disconnect();
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private createItemEl(item: PromptQueueItem, index: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "prompt-queue-row";
    row.dataset.id = item.id;
    // Row palette: CSS keys off data-mode (+ .is-idle on the container).
    row.dataset.mode = item.mode;

    const editing = this.editingId === item.id;
    if (editing) row.classList.add("is-editing");

    if (editing) {
      row.append(this.createEditEl(item));
    } else {
      const ico = document.createElement("span");
      ico.className = "prompt-queue-row-ico";
      if (item.mode === "interrupt") {
        ico.append(createLucideIcon(Zap, { size: 12 }));
      } else {
        ico.textContent = String(index + 1);
      }
      row.append(ico);

      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "prompt-queue-row-text";
      preview.textContent = item.text.trim() || attachmentFallbackLabel(item);
      preview.title = "Click to edit";
      preview.addEventListener("click", () => {
        this.editingId = item.id;
        this.render();
      });
      row.append(preview);

      if (item.attachments.length > 0) {
        const att = document.createElement("span");
        att.className = "prompt-queue-row-att";
        att.title =
          item.attachments.length === 1
            ? item.attachments[0]?.name ?? "Attachment"
            : `${item.attachments.length} attachments`;
        att.append(createLucideIcon(Paperclip, { size: 10 }));
        const n = document.createElement("span");
        n.textContent = String(item.attachments.length);
        att.append(n);
        row.append(att);
      }

      const state = document.createElement("span");
      state.className = "prompt-queue-row-state";
      state.textContent = this.stateLabel(item);
      if (item.mode === "interrupt") {
        state.title =
          "Inserts after the current model request and tools finish";
      }
      row.append(state);
    }

    const actions = document.createElement("div");
    actions.className = "prompt-queue-actions";

    if (!editing) {
      // Insert into this turn / Cancel insert — explicit mid-turn arming.
      const promoteBtn = document.createElement("button");
      promoteBtn.type = "button";
      promoteBtn.className = "prompt-queue-action-btn is-promote";
      if (item.mode === "interrupt") {
        promoteBtn.classList.add("is-armed");
        promoteBtn.setAttribute("aria-label", "Cancel insert into this turn");
        promoteBtn.title = "Cancel insert — wait for the turn to finish";
        promoteBtn.append(createLucideIcon(Hourglass, { size: 13 }));
        promoteBtn.addEventListener("click", () => {
          this.handlers?.onDefer(item.id);
        });
      } else {
        const sendNow = this.sessionIdle;
        promoteBtn.setAttribute(
          "aria-label",
          sendNow ? "Send this message now" : "Insert into the running turn",
        );
        promoteBtn.title = sendNow
          ? "Send now"
          : "Insert into this turn after the current step finishes";
        promoteBtn.append(
          createLucideIcon(sendNow ? CornerDownLeft : Zap, { size: 13 }),
        );
        promoteBtn.addEventListener("click", () => {
          this.handlers?.onPromote(item.id);
        });
      }
      actions.append(promoteBtn);

      if (this.items.length > 1 && index > 0) {
        const moveFrontBtn = document.createElement("button");
        moveFrontBtn.type = "button";
        moveFrontBtn.className = "prompt-queue-action-btn";
        moveFrontBtn.setAttribute("aria-label", "Move to front of queue");
        moveFrontBtn.title = "Move to front";
        moveFrontBtn.append(createLucideIcon(ArrowUpToLine, { size: 13 }));
        moveFrontBtn.addEventListener("click", () => {
          this.handlers?.onMoveToFront(item.id);
        });
        actions.append(moveFrontBtn);
      }

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "prompt-queue-action-btn";
      editBtn.setAttribute("aria-label", "Edit queued message");
      editBtn.title = "Edit";
      editBtn.append(createLucideIcon(Pencil, { size: 13 }));
      editBtn.addEventListener("click", () => {
        this.editingId = item.id;
        this.render();
      });
      actions.append(editBtn);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "prompt-queue-action-btn is-remove";
    removeBtn.setAttribute("aria-label", "Remove queued message");
    removeBtn.title = "Remove";
    removeBtn.append(createLucideIcon(X, { size: 13 }));
    removeBtn.addEventListener("mousedown", (event) => {
      // Avoid blur-commit racing remove when editing.
      event.preventDefault();
    });
    removeBtn.addEventListener("click", () => {
      this.editingId = null;
      this.handlers?.onRemove(item.id);
    });
    actions.append(removeBtn);

    row.append(actions);
    return row;
  }

  /** Inline editor for one row (the row grows while editing). */
  private createEditEl(item: PromptQueueItem): HTMLElement {
    const textarea = document.createElement("textarea");
    textarea.className = "prompt-queue-edit";
    textarea.value = item.text;
    textarea.rows = Math.min(4, Math.max(1, item.text.split("\n").length));
    textarea.setAttribute("aria-label", "Edit queued message");
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.editingId = null;
        this.render();
        return;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !isImeComposing(event)
      ) {
        event.preventDefault();
        this.commitEdit(item.id, textarea.value);
      }
    });
    textarea.addEventListener("blur", () => {
      if (this.editingId !== item.id) return;
      this.commitEdit(item.id, textarea.value);
    });
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return textarea;
  }

  /** One-line explanation of when this row will reach the agent. */
  private stateLabel(item: PromptQueueItem): string {
    if (item.mode === "interrupt") return "Next step";
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
