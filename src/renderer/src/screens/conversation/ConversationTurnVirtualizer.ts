import { LATEST_TURN_CLASS, TURN_CLASS } from "./conversationSticky.js";

export const TURN_VIRTUALIZE_MIN_TURNS = 8;
export const TURN_PARKED_ATTRIBUTE = "data-turn-parked";
const ROOT_MARGIN = "150% 0px 150% 0px";

const KEEP_LIVE_SELECTOR = [
  "[data-streaming='1']",
  "[data-ephemeral='1']",
  "[data-pending-user='1']",
  "[data-tool-streaming='1']",
  "[data-plan-create-tool-call-id]",
  ".content-card-ask-user-tool.is-asking",
  ".content-card-subagent-status-icon.is-in-progress",
].join(", ");

type ParkedTurn = {
  fragment: DocumentFragment;
  height: number;
  scroll: Array<{ el: HTMLElement; top: number; left: number }>;
};

export type TurnVirtualizerHooks = {
  adjustScroll?: (delta: number) => void;
  onRestore?: () => void;
  onDiscard?: (turn: HTMLElement) => void;
};

export class ConversationTurnVirtualizer {
  private readonly parked = new Map<HTMLElement, ParkedTurn>();
  private readonly roots = new WeakSet<Node>();
  private readonly observed = new Set<HTMLElement>();
  private readonly intersection: IntersectionObserver | null;
  private readonly mutations: MutationObserver | null;
  private destroyed = false;

  constructor(
    private readonly scrollport: HTMLElement,
    private readonly list: HTMLElement,
    private readonly hooks: TurnVirtualizerHooks = {},
  ) {
    this.intersection = typeof IntersectionObserver === "undefined" ? null :
      new IntersectionObserver((entries) => this.onIntersect(entries), {
        root: scrollport,
        rootMargin: ROOT_MARGIN,
        threshold: 0,
      });
    this.mutations = typeof MutationObserver === "undefined" ? null :
      new MutationObserver((records) => this.onMutate(records));
    this.mutations?.observe(list, { childList: true });
    for (const turn of this.turns()) this.observe(turn);
  }

  get parkedCount(): number {
    return this.parked.size;
  }

  isParked(node: Node): boolean {
    return this.roots.has(node.getRootNode());
  }

  isTurnParked(turn: HTMLElement): boolean {
    return this.parked.has(turn);
  }

  find<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    const live = this.list.querySelector<T>(selector);
    if (live) return live;
    for (const [turn, entry] of this.parked) {
      const hit = entry.fragment.querySelector<T>(selector);
      if (!hit) continue;
      this.restore(turn, true);
      return hit;
    }
    return null;
  }

  findAll<T extends HTMLElement = HTMLElement>(selector: string): T[] {
    for (const [turn, entry] of [...this.parked]) {
      if (entry.fragment.querySelector(selector)) this.restore(turn, true);
    }
    return Array.from(this.list.querySelectorAll<T>(selector));
  }

  exists(selector: string): boolean {
    if (this.list.querySelector(selector)) return true;
    for (const entry of this.parked.values()) {
      if (entry.fragment.querySelector(selector)) return true;
    }
    return false;
  }

  collect<T extends HTMLElement = HTMLElement>(selector: string): T[] {
    const found = Array.from(this.list.querySelectorAll<T>(selector));
    for (const entry of this.parked.values()) {
      found.push(...entry.fragment.querySelectorAll<T>(selector));
    }
    return found;
  }

  park(turn: HTMLElement, measuredHeight?: number): boolean {
    if (this.destroyed || this.parked.has(turn)) return false;
    if (turn.parentElement !== this.list || !turn.classList.contains(TURN_CLASS)) return false;
    if (!this.canPark(turn)) return false;
    const height = measuredHeight ?? turn.getBoundingClientRect().height;
    if (!(Number.isFinite(height) && height > 0)) return false;

    const scroll: ParkedTurn["scroll"] = [];
    for (const el of turn.querySelectorAll<HTMLElement>("*")) {
      if (el.scrollTop || el.scrollLeft) {
        scroll.push({ el, top: el.scrollTop, left: el.scrollLeft });
      }
    }
    const fragment = document.createDocumentFragment();
    this.roots.add(fragment);
    turn.style.boxSizing = "border-box";
    turn.style.height = `${height}px`;
    turn.setAttribute(TURN_PARKED_ATTRIBUTE, "1");
    fragment.append(...Array.from(turn.childNodes));
    this.parked.set(turn, { fragment, height, scroll });
    return true;
  }

  restore(turn: HTMLElement, compensate = false): boolean {
    const entry = this.parked.get(turn);
    if (!entry) return false;
    const above = compensate && turn.isConnected &&
      turn.getBoundingClientRect().bottom <= this.scrollport.getBoundingClientRect().top;
    this.parked.delete(turn);
    this.roots.delete(entry.fragment);
    turn.style.removeProperty("height");
    turn.style.removeProperty("box-sizing");
    turn.removeAttribute(TURN_PARKED_ATTRIBUTE);
    turn.append(entry.fragment);
    for (const item of entry.scroll) {
      item.el.scrollTop = item.top;
      item.el.scrollLeft = item.left;
    }
    if (above) {
      const delta = turn.getBoundingClientRect().height - entry.height;
      if (Math.abs(delta) >= 0.5) this.hooks.adjustScroll?.(delta);
    }
    if (compensate && this.intersection && this.observed.has(turn)) {
      this.intersection.unobserve(turn);
      this.intersection.observe(turn);
    }
    this.hooks.onRestore?.();
    return true;
  }

  releaseAll(): void {
    if (this.parked.size === 0) return;
    for (const [turn, entry] of [...this.parked]) {
      this.parked.delete(turn);
      this.roots.delete(entry.fragment);
      turn.style.removeProperty("height");
      turn.style.removeProperty("box-sizing");
      turn.removeAttribute(TURN_PARKED_ATTRIBUTE);
      turn.append(entry.fragment);
    }
    this.hooks.onRestore?.();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.releaseAll();
    this.destroyed = true;
    this.intersection?.disconnect();
    this.mutations?.disconnect();
    this.observed.clear();
  }

  private turns(): HTMLElement[] {
    return Array.from(this.list.querySelectorAll<HTMLElement>(`:scope > .${TURN_CLASS}`));
  }

  private canPark(turn: HTMLElement): boolean {
    const turns = this.turns();
    if (turns.length < TURN_VIRTUALIZE_MIN_TURNS) return false;
    if (turn.classList.contains(LATEST_TURN_CLASS) || turns[turns.length - 1] === turn) {
      return false;
    }
    if (turn.querySelector(KEEP_LIVE_SELECTOR)) return false;
    const active = document.activeElement;
    if (active && active !== document.body && turn.contains(active)) return false;
    const selection = typeof document.getSelection === "function" ? document.getSelection() : null;
    if (
      selection && selection.rangeCount > 0 && !selection.isCollapsed &&
      typeof selection.containsNode === "function" && selection.containsNode(turn, true)
    ) {
      return false;
    }
    for (const media of turn.querySelectorAll<HTMLMediaElement>("video, audio")) {
      if (!media.paused) return false;
    }
    return true;
  }

  private observe(turn: HTMLElement): void {
    if (this.observed.has(turn)) return;
    this.observed.add(turn);
    this.intersection?.observe(turn);
  }

  private forget(turn: HTMLElement): void {
    if (!this.observed.delete(turn)) return;
    this.intersection?.unobserve(turn);
    const entry = this.parked.get(turn);
    if (!entry) return;
    this.parked.delete(turn);
    this.roots.delete(entry.fragment);
    turn.style.removeProperty("height");
    turn.style.removeProperty("box-sizing");
    turn.removeAttribute(TURN_PARKED_ATTRIBUTE);
    turn.append(entry.fragment);
    this.hooks.onDiscard?.(turn);
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    if (this.destroyed) return;
    for (const entry of entries) {
      const turn = entry.target as HTMLElement;
      if (!this.observed.has(turn) || turn.parentElement !== this.list) continue;
      if (entry.isIntersecting) this.restore(turn, true);
    }
    for (const entry of entries) {
      const turn = entry.target as HTMLElement;
      if (!this.observed.has(turn) || turn.parentElement !== this.list) continue;
      if (!entry.isIntersecting) this.park(turn, entry.boundingClientRect.height);
    }
  }

  private onMutate(records: MutationRecord[]): void {
    if (this.destroyed) return;
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node instanceof HTMLElement && node.parentElement !== this.list) this.forget(node);
      }
      for (const node of record.addedNodes) {
        if (
          node instanceof HTMLElement &&
          node.parentElement === this.list &&
          node.classList.contains(TURN_CLASS)
        ) {
          this.observe(node);
        }
      }
    }
  }
}
