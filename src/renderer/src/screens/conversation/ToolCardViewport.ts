import {
  VIRTUAL_TOOL_CARD_CLASS,
  MAX_EXPANDED_TOOL_CARDS,
  disposeVirtualToolCard,
  getVirtualToolCardOpen,
  isVirtualToolCard,
  measureVirtualToolCard,
  resumeVirtualToolCard,
  setVirtualToolCardOpen,
  suspendVirtualToolCard,
} from "./cards/virtualToolCard.js";

/** One observer pair per transcript, never a scroll loop over all code lines. */
export class ToolCardViewport {
  private readonly slots = new Set<HTMLElement>();
  private readonly intersection: IntersectionObserver | null;
  private readonly resize: ResizeObserver | null;
  private readonly mutations: MutationObserver | null;
  private destroyed = false;

  private readonly onToggle = (event: Event): void => {
    const card = event.target;
    if (!(card instanceof HTMLElement) || card.tagName !== "DETAILS") return;
    const slot = card.parentElement;
    // Nested diff/details controls do not consume another transcript slot.
    if (slot && this.slots.has(slot) && getVirtualToolCardOpen(slot)) {
      this.limitExpandedCards(slot);
    }
  };

  /** Include suspended cards: scrolling back must not resurrect an older open body. */
  private limitExpandedCards(preferred?: HTMLElement): void {
    const open = this.collectSlots(this.list)
      .filter((slot) => getVirtualToolCardOpen(slot) === true);
    let excess = open.length - MAX_EXPANDED_TOOL_CARDS;
    for (const slot of open) {
      if (excess <= 0) break;
      if (slot === preferred) continue;
      setVirtualToolCardOpen(slot, false);
      excess -= 1;
    }
  }

  private collectSlots(root: HTMLElement): HTMLElement[] {
    return [
      ...(isVirtualToolCard(root) ? [root] : []),
      ...root.querySelectorAll<HTMLElement>(`.${VIRTUAL_TOOL_CARD_CLASS}`),
    ];
  }

  constructor(
    scrollport: HTMLElement,
    private readonly list: HTMLElement,
  ) {
    this.intersection = typeof IntersectionObserver === "undefined" ? null :
      new IntersectionObserver((entries) => {
        if (this.destroyed) return;
        // The observer already measured these boxes. Don't force one layout
        // per outgoing card while replacing a batch with equal-height slots.
        for (const entry of entries) {
          const slot = entry.target as HTMLElement;
          if (!this.slots.has(slot) || !this.list.contains(slot)) continue;
          if (!entry.isIntersecting) {
            suspendVirtualToolCard(slot, entry.boundingClientRect.height);
          }
        }
        for (const entry of entries) {
          const slot = entry.target as HTMLElement;
          if (!this.slots.has(slot) || !this.list.contains(slot)) continue;
          if (entry.isIntersecting) resumeVirtualToolCard(slot);
        }
      }, { root: scrollport, rootMargin: "0px", threshold: 0 });
    this.resize = typeof ResizeObserver === "undefined" ? null :
      new ResizeObserver((entries) => {
        if (this.destroyed) return;
        for (const entry of entries) {
          const slot = entry.target as HTMLElement;
          if (this.slots.has(slot)) {
            measureVirtualToolCard(slot, entry.borderBoxSize[0]?.blockSize);
          }
        }
      });
    // Reconcile/turn layout frequently moves existing nodes. Test containment
    // at the end of the mutation batch, not each removedNode in isolation.
    this.mutations = typeof MutationObserver === "undefined" ? null :
      new MutationObserver((records) => {
        if (this.destroyed) return;
        const removed = new Set<HTMLElement>();
        const added = new Set<HTMLElement>();
        for (const record of records) {
          // Highlight spans / streamed lines / fold buttons never introduce
          // slots. Skip their subtrees instead of scanning code on every chunk.
          if (record.target instanceof HTMLElement &&
              record.target.closest(`.${VIRTUAL_TOOL_CARD_CLASS}`)) continue;
          for (const node of record.removedNodes) {
            if (node instanceof HTMLElement) {
              for (const slot of this.collectSlots(node)) removed.add(slot);
            }
          }
          for (const node of record.addedNodes) {
            if (node instanceof HTMLElement) {
              for (const slot of this.collectSlots(node)) added.add(slot);
            }
          }
        }
        for (const slot of added) {
          if (this.list.contains(slot)) this.observe(slot);
        }
        for (const slot of removed) {
          if (!this.list.contains(slot)) this.release(slot);
        }
        if (added.size || removed.size) this.limitExpandedCards();
      });
    this.mutations?.observe(list, { childList: true, subtree: true });
    list.addEventListener("toggle", this.onToggle, true);
    this.observeTree(list);
    this.limitExpandedCards();
  }

  private observeTree(root: HTMLElement): void {
    if (!this.list.contains(root)) return;
    for (const slot of this.collectSlots(root)) this.observe(slot);
  }

  private observe(slot: HTMLElement): void {
    if (this.slots.has(slot) || !isVirtualToolCard(slot)) return;
    this.slots.add(slot);
    this.intersection?.observe(slot);
    this.resize?.observe(slot);
  }

  private release(slot: HTMLElement): void {
    this.intersection?.unobserve(slot);
    this.resize?.unobserve(slot);
    this.slots.delete(slot);
    disposeVirtualToolCard(slot);
  }

  /** Release observers/factories even if the whole view leaves the document. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.intersection?.disconnect();
    this.resize?.disconnect();
    this.mutations?.disconnect();
    this.list.removeEventListener("toggle", this.onToggle, true);
    for (const slot of this.slots) disposeVirtualToolCard(slot);
    this.slots.clear();
  }
}
