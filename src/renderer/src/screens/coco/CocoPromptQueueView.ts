import { ArrowUp, ArrowUpToLine, ChevronDown, ChevronUp, CornerDownLeft, Ellipsis, Layers, Paperclip, Pencil, Undo2, X } from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import { isImeComposing } from "../../ui/ime.js";
import type { PromptQueueHandlers, PromptQueueItem } from "../conversation/PromptQueueView.js";
import { el } from "./dom.js";

let nextQueueId = 0;

/** CoCo's compact presentation of the native session queue. Mutations stay with its controller. */
export class CocoPromptQueueView {
  readonly root = el("div", "coco-prompt-queue");
  private head = el("div", "coco-queue-head");
  private toggle = el("button", "coco-queue-toggle");
  private hint = el("span", "coco-queue-hint");
  private rows = el("div", "coco-queue-rows");
  private menu = el("div", "coco-queue-menu");
  private menuTrigger: HTMLButtonElement | undefined;
  private menuOpen = false;
  private items: PromptQueueItem[] = [];
  private handlers: PromptQueueHandlers | null = null;
  private idle = false;
  private collapsed = false;
  private editingId: string | null = null;
  private draft = "";
  private destroyed = false;
  private closeOnResize = (): void => this.closeMenu();

  constructor() {
    const id = `coco-queue-${++nextQueueId}`;
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Queued messages");
    this.rows.id = `${id}-rows`;
    this.toggle.type = "button";
    this.toggle.setAttribute("aria-controls", this.rows.id);
    this.toggle.onclick = () => {
      this.collapsed = !this.collapsed;
      this.closeMenu();
      this.render();
    };
    this.head.append(this.toggle, this.hint);
    this.menu.id = `${id}-menu`;
    this.menu.setAttribute("popover", "auto");
    this.menu.setAttribute("aria-label", "Queued message actions");
    this.menu.addEventListener("toggle", event => {
      if ((event as ToggleEvent).newState === "closed") {
        this.menuOpen = false;
        this.menuTrigger?.setAttribute("aria-expanded", "false");
      }
    });
    this.menu.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const trigger = this.menuTrigger;
      this.closeMenu();
      trigger?.focus();
    });
    this.rows.addEventListener("scroll", () => this.closeMenu());
    window.addEventListener("resize", this.closeOnResize);
    this.root.append(this.head, this.rows, this.menu);
  }

  setHandlers(handlers: PromptQueueHandlers | null): void { this.handlers = handlers; }

  setItems(items: PromptQueueItem[]): void {
    if (this.destroyed || JSON.stringify(items) === JSON.stringify(this.items)) return;
    this.items = items.map(item => ({ ...item, attachments: item.attachments.map(attachment => ({ ...attachment })) }));
    if (!items.length) this.collapsed = false;
    if (!items.some(item => item.id === this.editingId)) this.editingId = null;
    this.render();
  }

  setSessionIdle(idle: boolean): void {
    if (this.destroyed || this.idle === idle) return;
    this.idle = idle;
    this.render();
  }

  destroy(): void {
    this.closeMenu();
    this.destroyed = true;
    this.handlers = null;
    window.removeEventListener("resize", this.closeOnResize);
    this.root.replaceChildren();
  }

  private render(): void {
    const editor = this.rows.querySelector<HTMLTextAreaElement>("textarea");
    const focused = editor !== null && document.activeElement === editor;
    const selection = editor ? [editor.selectionStart, editor.selectionEnd] as const : undefined;
    const scrollTop = this.rows.scrollTop;
    this.closeMenu();
    this.root.hidden = !this.items.length;
    this.toggle.setAttribute("aria-expanded", String(!this.collapsed));
    this.toggle.replaceChildren(createLucideIcon(Layers, { size: 12 }), el("span", "", "Queued"), el("span", "coco-queue-count", `· ${this.items.length}`), createLucideIcon(this.collapsed ? ChevronDown : ChevronUp, { size: 10 }));
    this.hint.textContent = this.idle ? "Ready to send" : this.items.some(item => item.mode === "interrupt") ? "After current step" : "After this turn";
    this.rows.hidden = this.collapsed;
    this.rows.replaceChildren(...this.items.map((item, index) => this.row(item, index)));
    this.rows.scrollTop = scrollTop;
    if (focused) {
      const next = this.rows.querySelector<HTMLTextAreaElement>("textarea");
      next?.focus();
      if (selection) next?.setSelectionRange(...selection);
    }
  }

  private row(item: PromptQueueItem, index: number): HTMLElement {
    const armed = item.mode === "interrupt" && !this.idle;
    const row = el("div", `coco-queue-row${armed ? " is-armed" : ""}`);
    row.dataset.id = item.id;
    const order = el("span", "coco-queue-index");
    if (armed) order.append(createLucideIcon(CornerDownLeft, { size: 12 }));
    else order.textContent = String(index + 1);
    row.append(order);
    if (this.editingId === item.id) {
      row.classList.add("is-editing");
      row.append(this.editor(item));
      return row;
    }
    const text = item.text.trim() || item.attachments[0]?.name || "(empty)";
    const preview = this.action(text, "coco-queue-text", () => this.edit(item));
    preview.textContent = text;
    preview.setAttribute("aria-label", `Edit queued message ${index + 1}: ${text}`);
    row.append(preview);
    if (item.attachments.length) {
      const attachments = el("span", "coco-queue-attachments", String(item.attachments.length));
      attachments.prepend(createLucideIcon(Paperclip, { size: 11 }));
      attachments.title = item.attachments.map(attachment => attachment.name).join(", ");
      row.append(attachments);
    }
    const label = this.idle ? "Send now" : armed ? "Wait until this turn ends" : "Insert after the current step";
    const insert = this.action(label, "coco-queue-action is-insert", () => {
      if (armed && !this.idle) this.handlers?.onDefer(item.id);
      else this.handlers?.onPromote(item.id);
    });
    insert.append(createLucideIcon(this.idle ? ArrowUp : armed ? Undo2 : CornerDownLeft, { size: 13 }));
    const more = this.action(`More actions for message ${index + 1}`, "coco-queue-action", () => this.openMenu(item, index, more));
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", this.menu.id);
    more.append(createLucideIcon(Ellipsis, { size: 14 }));
    row.append(insert, more);
    return row;
  }

  private edit(item: PromptQueueItem): void {
    this.editingId = item.id;
    this.draft = item.text;
    this.collapsed = false;
    this.render();
    this.rows.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }

  private editor(item: PromptQueueItem): HTMLElement {
    const wrap = el("div", "coco-queue-editor-wrap");
    const textarea = el("textarea", "coco-queue-edit");
    textarea.value = this.draft;
    textarea.rows = Math.min(4, Math.max(2, this.draft.split("\n").length));
    textarea.setAttribute("aria-label", "Edit queued message");
    textarea.oninput = () => { this.draft = textarea.value; textarea.setCustomValidity(""); };
    const cancel = (): void => { this.editingId = null; this.render(); this.focusMessage(item.id); };
    const save = (): void => {
      if (!textarea.value.trim() && !item.attachments.length) {
        textarea.setCustomValidity("Message cannot be empty."); textarea.reportValidity(); return;
      }
      const text = textarea.value.trimEnd();
      this.editingId = null;
      this.render();
      this.focusMessage(item.id);
      this.handlers?.onUpdateText(item.id, text);
    };
    textarea.onkeydown = event => {
      if (isImeComposing(event)) return;
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!event.repeat) save(); }
    };
    const actions = el("div", "coco-queue-edit-actions");
    const cancelButton = this.action("Cancel", "coco-button", cancel); cancelButton.textContent = "Cancel";
    const saveButton = this.action("Save", "coco-button primary", save); saveButton.textContent = "Save";
    actions.append(cancelButton, saveButton);
    wrap.append(textarea, actions);
    return wrap;
  }

  private focusMessage(id: string): void {
    [...this.rows.querySelectorAll<HTMLElement>(".coco-queue-row")].find(row => row.dataset.id === id)?.querySelector<HTMLButtonElement>(".coco-queue-text")?.focus();
  }

  private openMenu(item: PromptQueueItem, index: number, trigger: HTMLButtonElement): void {
    const open = trigger === this.menuTrigger && this.menuOpen;
    this.closeMenu();
    if (open) return;
    const entry = (label: string, icon: typeof Pencil, action: () => void): HTMLButtonElement => {
      const button = this.action(label, "", () => { this.closeMenu(); action(); });
      button.append(createLucideIcon(icon, { size: 13 }), el("span", "", label));
      return button;
    };
    const edit = entry("Edit", Pencil, () => this.edit(item));
    const front = entry("Move to front", ArrowUpToLine, () => this.handlers?.onMoveToFront(item.id));
    front.disabled = index === 0;
    const remove = entry("Remove", X, () => this.handlers?.onRemove(item.id));
    this.menu.replaceChildren(edit, front, remove);
    this.menuTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    this.menu.showPopover();
    this.menuOpen = true;
    const rect = trigger.getBoundingClientRect(), menu = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(rect.right - menu.width, window.innerWidth - menu.width - 8))}px`;
    this.menu.style.top = `${rect.bottom + menu.height + 8 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - menu.height - 4)}px`;
    edit.focus();
  }

  private closeMenu(): void {
    if (this.menuOpen && this.menu.isConnected) this.menu.hidePopover();
    this.menuOpen = false;
    this.menuTrigger?.setAttribute("aria-expanded", "false");
    this.menuTrigger = undefined;
  }

  private action(label: string, className: string, run: () => void): HTMLButtonElement {
    const button = el("button", className);
    button.type = "button"; button.title = label; button.setAttribute("aria-label", label); button.onclick = run;
    return button;
  }
}
