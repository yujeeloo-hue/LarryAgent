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
import { parseDemoConfirmMessage } from "../../../../session/demoConfirm.js";
import { prefersReducedMotion } from "./foldAnimation.js";
import "./prompt-queue.css";

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
  onPromote: (id: string) => void;
  onDefer: (id: string) => void;
};

const QUEUE_MOTION = { duration: 260, easing: "cubic-bezier(.22, 1, .36, 1)" };
let queueInstance = 0;

export class PromptQueueView {
  readonly root: HTMLElement;
  private items: PromptQueueItem[] = [];
  private handlers: PromptQueueHandlers | null = null;
  private editingId: string | null = null;
  private open = false;
  private collapsed = false;
  private readonly rowsId = `prompt-queue-rows-${++queueInstance}`;
  private readonly rowsResizeObserver: ResizeObserver | null;
  private heightMotion: { animation: Animation; target: number } | null = null;
  private onOpenChange: ((open: boolean) => void) | null = null;
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
  }

  setOnOpenChange(handler: ((open: boolean) => void) | null): void {
    this.onOpenChange = handler;
  }

  setHandlers(handlers: PromptQueueHandlers | null): void {
    this.handlers = handlers;
  }

  destroy(): void {
    this.rowsResizeObserver?.disconnect();
    this.heightMotion?.animation.cancel();
    this.heightMotion = null;
    this.open = false;
    this.handlers = null;
    this.onOpenChange = null;
    this.root.replaceChildren();
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
    // The queue event and the enqueue reply can carry the same snapshot.
    if (
      items.length === this.items.length &&
      items.every((item, index) => {
        const previous = this.items[index];
        return previous && sameQueueItemPreview(previous, item);
      }) &&
      !this.root.querySelector(".prompt-queue-edit")
    ) {
      return;
    }
    const previousIds = new Set(this.items.map((item) => item.id));
    const added = new Set(items.filter((item) => !previousIds.has(item.id)).map((item) => item.id));
    const membershipChanged = added.size > 0 || items.length !== this.items.length;
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
    this.render(added, membershipChanged);
  }

  private render(added?: ReadonlySet<string>, membershipChanged = false): void {
    if (this.items.length === 0) {
      this.startHide();
      return;
    }
    const animate = this.canAnimate();
    const resize = (membershipChanged && !this.collapsed) || this.heightMotion;
    const before = resize && animate ? this.root.getBoundingClientRect().height : null;
    const { box, rows } = this.mountList();
    this.startShow();
    if (before !== null) {
      this.animateHeight(before, box.getBoundingClientRect().height);
    } else if (this.heightMotion) {
      this.heightMotion.animation.cancel();
      this.heightMotion = null;
    }

    if (!added?.size || this.collapsed) return;
    if (animate) {
      for (const row of rows.children) {
        const id = (row as HTMLElement).dataset.id;
        if (id && added.has(id)) {
          row.firstElementChild?.animate(
            [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
            { ...QUEUE_MOTION, duration: 220, delay: before === 0 ? 45 : 0, fill: "backwards" },
          );
        }
      }
    }
    const last = this.items.at(-1);
    if (last && added.has(last.id) && rows.scrollHeight > rows.clientHeight) {
      rows.scrollTo({ top: rows.scrollHeight, behavior: animate ? "smooth" : "instant" });
    }
  }

  private canAnimate(): boolean {
    return this.root.isConnected && typeof this.root.animate === "function" && !prefersReducedMotion();
  }

  private animateHeight(from: number, to: number): void {
    if (this.heightMotion?.target === to) return;
    this.heightMotion?.animation.cancel();
    this.heightMotion = null;
    if (Math.abs(from - to) < 0.5 || !this.canAnimate()) {
      if (!this.open) this.finishHide();
      return;
    }
    const animation = this.root.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { ...QUEUE_MOTION, fill: "both" },
    );
    this.heightMotion = { animation, target: to };
    animation.onfinish = () => {
      if (this.heightMotion?.animation !== animation) return;
      this.heightMotion = null;
      if (!this.open) this.finishHide();
      animation.cancel();
    };
  }

  private mountList(): { box: HTMLElement; rows: HTMLElement } {
    const previousRows = this.root.querySelector<HTMLElement>(".prompt-queue-rows");
    const scrollTop = previousRows?.scrollTop ?? 0;
    const previousRowContents = new Map(
      Array.from(previousRows?.children ?? [], (row) => [row.getAttribute("data-id"), row.firstElementChild]),
    );
    this.rowsResizeObserver?.disconnect();
    this.root.classList.toggle("is-collapsed", this.collapsed);
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
      const row = this.createItemEl(item, index);
      const animation = previousRowContents.get(item.id)?.getAnimations?.()[0];
      if (animation?.effect && animation.effect instanceof KeyframeEffect) {
        // A new queue snapshot can arrive while this row is still entering.
        animation.effect.target = row.firstElementChild;
      }
      rows.append(row);
    });
    list.append(rows);
    box.append(list);

    const next = document.createElement("div");
    next.className = "prompt-queue-next";
    next.hidden = !this.collapsed;
    next.append(createLucideIcon(CornerDownRight, { size: 12 }));
    const preview = document.createElement("span");
    const first = this.items[0];
    preview.textContent = first ? previewText(first) : "";
    preview.title = preview.textContent;
    next.append(preview);
    box.append(next);

    this.root.replaceChildren(box);
    if (scrollTop > 0) rows.scrollTop = scrollTop;
    this.rowsResizeObserver?.observe(rows);
    return { box, rows };
  }

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
    toggle.addEventListener("mousedown", (event) => event.preventDefault());
    toggle.addEventListener("click", () => {
      this.setCollapsed(!this.collapsed);
      this.root.querySelector<HTMLButtonElement>(".prompt-queue-toggle")?.focus();
    });
    head.append(toggle);
    return head;
  }

  private setCollapsed(collapsed: boolean): void {
    const before = this.root.getBoundingClientRect().height;
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
    const box = this.root.firstElementChild;
    if (box) this.animateHeight(before, box.getBoundingClientRect().height);
  }

  private startShow(): void {
    if (this.open) return;
    this.open = true;
    this.root.hidden = false;
    void this.root.offsetWidth;
    this.root.classList.add("is-visible");
    this.onOpenChange?.(true);
  }

  private startHide(): void {
    if (!this.open) return;
    const before = this.root.getBoundingClientRect().height;
    this.open = false;
    this.root.classList.remove("is-visible");
    this.onOpenChange?.(false);
    this.animateHeight(before, 0);
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
    row.dataset.mode = item.mode;
    const content = document.createElement("div");
    content.className = "prompt-queue-row-content";
    row.append(content);

    const editing = this.editingId === item.id;
    if (editing) row.classList.add("is-editing");

    if (editing) {
      content.append(this.createEditEl(item));
    } else {
      const ico = document.createElement("span");
      ico.className = "prompt-queue-row-ico";
      if (item.mode === "interrupt") {
        ico.append(createLucideIcon(Zap, { size: 12 }));
      } else {
        ico.textContent = String(index + 1);
      }
      content.append(ico);

      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "prompt-queue-row-text";
      preview.textContent = previewText(item);
      preview.title = "Click to edit";
      preview.addEventListener("click", () => {
        this.editingId = item.id;
        this.render();
      });
      content.append(preview);

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
        content.append(att);
      }

      const state = document.createElement("span");
      state.className = "prompt-queue-row-state";
      state.textContent = this.stateLabel(item);
      if (item.mode === "interrupt") {
        state.title =
          "Inserts after the current model request and tools finish";
      }
      content.append(state);
    }

    const actions = document.createElement("div");
    actions.className = "prompt-queue-actions";

    if (!editing) {
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
      event.preventDefault();
    });
    removeBtn.addEventListener("click", () => {
      this.editingId = null;
      this.handlers?.onRemove(item.id);
    });
    actions.append(removeBtn);

    content.append(actions);
    return row;
  }

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

function sameQueueItemPreview(a: PromptQueueItem, b: PromptQueueItem): boolean {
  return a.id === b.id && a.text === b.text && a.mode === b.mode &&
    a.attachments.length === b.attachments.length &&
    (a.attachments.length !== 1 || a.attachments[0]?.name === b.attachments[0]?.name);
}

function attachmentFallbackLabel(item: PromptQueueItem): string {
  if (item.attachments.length === 0) return "(empty)";
  if (item.attachments.length === 1) {
    return item.attachments[0]?.name ?? "Attachment";
  }
  return `${item.attachments.length} attachments`;
}

function previewText(item: PromptQueueItem): string {
  const demoConfirm = parseDemoConfirmMessage(item.text);
  if (demoConfirm) {
    let count = 0;
    try {
      const parsed: unknown = JSON.parse(demoConfirm.paramsJson.trim() || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        count = Object.keys(parsed as Record<string, unknown>).length;
      }
    } catch {
      count = 0;
    }
    return count > 0 ? `Demo confirmed · ${count} params` : "Demo confirmed";
  }
  return item.text.trim() || attachmentFallbackLabel(item);
}
