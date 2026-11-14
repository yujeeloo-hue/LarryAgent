import { disposeCardResources } from "./cardResources.js";
import {
  captureToolCardState,
  getToolCardOpen,
  restoreToolCardState,
  setToolCardOpen,
} from "./toolCardState.js";
import type { ToolInvocationCardInput } from "./toolInvocationTypes.js";

export const VIRTUAL_TOOL_CARD_CLASS = "conversation-tool-slot";
export const MAX_EXPANDED_TOOL_CARDS = 5;

type CardFactory = (input: ToolInvocationCardInput) => HTMLElement;
type CardState = ReturnType<typeof captureToolCardState>;
type VirtualCard = {
  input: ToolInvocationCardInput;
  render: CardFactory;
  state: CardState | null;
  height: number;
  suspended: boolean;
  disposed: boolean;
};

// The slot owns data, never a detached card or cached HTML. A discarded slot
// and its source snapshot can be collected together, including aborted renders.
const cards = new WeakMap<HTMLElement, VirtualCard>();

export function isVirtualizedToolName(name: string): boolean {
  return name === "write_file" || name === "append_file" ||
    name === "patch" || name === "edit_file" || name === "write_plan_doc";
}

export function isVirtualToolCard(node: HTMLElement): boolean {
  return cards.has(node);
}

function syncIdentity(slot: HTMLElement, data: VirtualCard): void {
  slot.dataset.toolCallId = data.input.id;
  slot.dataset.toolName = data.input.name;
  if (slot.firstElementChild?.hasAttribute("data-tool-streaming")) {
    slot.dataset.toolStreaming = "1";
  } else {
    delete slot.dataset.toolStreaming;
  }
  // Only the stable slot has the call id, so reconcile / queries see one card.
  const card = slot.firstElementChild as HTMLElement | null;
  if (card) {
    delete card.dataset.toolCallId;
    delete card.dataset.toolStreaming;
  }
}

/** Initial paint is measured once, so no approximate placeholder heights. */
export function createVirtualToolCard(
  input: ToolInvocationCardInput,
  render: CardFactory,
): HTMLElement {
  const slot = document.createElement("div");
  slot.className = VIRTUAL_TOOL_CARD_CLASS;
  const data: VirtualCard = {
    input, render, state: null, height: 0, suspended: false, disposed: false,
  };
  cards.set(slot, data);
  slot.append(render(input));
  syncIdentity(slot, data);
  return slot;
}

export function virtualToolCardIsSuspended(slot: HTMLElement): boolean {
  return cards.get(slot)?.suspended === true;
}

/** Called on every live chunk, before the DOM fast path. No hidden repaint. */
export function updateVirtualToolCardInput(
  slot: HTMLElement,
  update: Partial<ToolInvocationCardInput>,
): boolean {
  const data = cards.get(slot);
  if (!data || data.disposed) return false;
  // Keep the lazy body's input reference current without retaining code DOM.
  Object.assign(data.input, update, { id: slot.dataset.toolCallId ?? data.input.id });
  slot.dataset.toolName = data.input.name;
  if (!data.input.result) slot.dataset.toolStreaming = "1";
  return data.suspended || getVirtualToolCardOpen(slot) === false;
}

export function measureVirtualToolCard(slot: HTMLElement, measuredHeight?: number): number {
  const data = cards.get(slot);
  if (!data || data.disposed) return 0;
  const height = measuredHeight ?? slot.getBoundingClientRect().height;
  if (Number.isFinite(height) && height > 0) data.height = height;
  return data.height;
}

/** Leave exactly one empty, equally sized slot in the document. */
export function suspendVirtualToolCard(slot: HTMLElement, measuredHeight?: number): boolean {
  const data = cards.get(slot);
  if (!data || data.disposed || data.suspended) return false;
  const height = measureVirtualToolCard(slot, measuredHeight);
  if (!(height > 0)) return false; // detached / hidden ancestor: don't cache 0
  const card = slot.firstElementChild as HTMLElement | null;
  if (card) data.state = captureToolCardState(card);
  disposeCardResources(slot);
  slot.style.height = `${height}px`;
  slot.dataset.toolPlaceholder = "1";
  slot.setAttribute("aria-hidden", "true");
  slot.replaceChildren();
  data.suspended = true;
  return true;
}

/** Rebuild from the latest data, not a retained detached subtree. */
export function resumeVirtualToolCard(slot: HTMLElement): boolean {
  const data = cards.get(slot);
  if (!data || data.disposed || !data.suspended) return false;
  data.input = {
    ...data.input,
    id: slot.dataset.toolCallId ?? data.input.id,
    initiallyCollapsed: data.state?.open === false,
  };
  const card = data.render(data.input);
  slot.append(card);
  syncIdentity(slot, data);
  slot.style.removeProperty("height");
  delete slot.dataset.toolPlaceholder;
  slot.removeAttribute("aria-hidden");
  if (data.state) restoreToolCardState(card, data.state);
  data.suspended = false;
  return true;
}

export function getVirtualToolCardOpen(slot: HTMLElement): boolean | null {
  const data = cards.get(slot);
  if (!data) return getToolCardOpen(slot);
  if (data.disposed) return null;
  if (data.suspended) return data.state?.open ?? null;
  const card = slot.firstElementChild as HTMLDetailsElement | null;
  return card?.tagName === "DETAILS" ? card.open : null;
}

export function setVirtualToolCardOpen(slot: HTMLElement, open: boolean): void {
  const data = cards.get(slot);
  if (!data) {
    setToolCardOpen(slot, open);
    return;
  }
  if (data.disposed) return;
  if (data.state) data.state.open = open;
  const card = slot.firstElementChild as HTMLDetailsElement | null;
  if (card) setToolCardOpen(card, open);
}

/** Reconcile snapshots / finish events without resurrecting an offscreen card. */
export function transferVirtualToolCardState(
  from: HTMLElement,
  to: HTMLElement,
  options?: { preserveBody?: boolean },
): void {
  const previous = cards.get(from);
  const next = cards.get(to);
  if (!previous || !next || previous.disposed || next.disposed) return;
  const current = from.firstElementChild as HTMLElement | null;
  const state = current ? captureToolCardState(current) : previous.state;
  next.height = previous.height;
  next.state = state;
  if (state && options?.preserveBody === false) {
    next.state = { open: state.open, details: [], scroll: [], folds: [] };
  }
  if (previous.suspended) {
    disposeCardResources(to);
    to.replaceChildren();
    to.style.height = `${next.height}px`;
    to.dataset.toolPlaceholder = "1";
    to.setAttribute("aria-hidden", "true");
    next.suspended = true;
  } else if (next.state && to.firstElementChild) {
    restoreToolCardState(to.firstElementChild as HTMLElement, next.state);
  }
}

/** Idempotent; observer removal must not leave a retained render factory. */
export function disposeVirtualToolCard(slot: HTMLElement): void {
  const data = cards.get(slot);
  if (!data || data.disposed) return;
  data.disposed = true;
  disposeCardResources(slot);
  slot.replaceChildren();
  cards.delete(slot);
}
