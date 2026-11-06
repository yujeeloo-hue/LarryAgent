import {
  captureDiffFoldState,
  restoreDiffFoldState,
} from "./DiffLinedFileView.js";
import { disposeCardResources, onCardDispose } from "./cardResources.js";

const bodySync = new WeakMap<HTMLElement, () => void>();
const collapsedBodyState = new WeakMap<HTMLElement, ToolCardState>();

const SCROLL_SELECTOR = [
  ".tool-file-lines",
  ".content-card-terminal",
  ".content-card-table-scroll",
  ".content-card-svg-preview",
].join(",");

type ToolCardState = {
  open: boolean | null;
  details: boolean[];
  scroll: Array<{ top: number; left: number }>;
  folds: string[][];
};

/** Plain data only: never retain detached DOM in a virtualized card's state. */
export function captureToolCardState(card: HTMLElement): ToolCardState {
  const saved = collapsedBodyState.get(card);
  if (saved && getToolCardOpen(card) === false) return { ...saved, open: false };
  return {
    open: getToolCardOpen(card),
    details: Array.from(card.querySelectorAll<HTMLDetailsElement>("details"),
      (el) => el.open),
    scroll: Array.from(card.querySelectorAll<HTMLElement>(SCROLL_SELECTOR),
      (el) => ({ top: el.scrollTop, left: el.scrollLeft })),
    folds: Array.from(card.querySelectorAll<HTMLElement>(".tool-file-diff"),
      captureDiffFoldState),
  };
}

export function restoreToolCardState(card: HTMLElement, state: ToolCardState): void {
  if (state.open !== null) setToolCardOpen(card, state.open);
  if (state.open === false && bodySync.has(card)) {
    collapsedBodyState.set(card, { ...state, open: null });
    return;
  }
  card.querySelectorAll<HTMLDetailsElement>("details").forEach((el, i) => {
    if (state.details[i] !== undefined) el.open = state.details[i]!;
  });
  card.querySelectorAll<HTMLElement>(".tool-file-diff").forEach((el, i) => {
    restoreDiffFoldState(el, state.folds[i] ?? []);
  });
  card.querySelectorAll<HTMLElement>(SCROLL_SELECTOR).forEach((el, i) => {
    const scroll = state.scroll[i];
    if (!scroll) return;
    el.scrollTop = scroll.top;
    el.scrollLeft = scroll.left;
  });
}

export function getToolCardOpen(card: HTMLElement): boolean | null {
  return card.tagName === "DETAILS" ? (card as HTMLDetailsElement).open : null;
}

export function setToolCardOpen(card: HTMLElement, open: boolean): void {
  if (card.tagName !== "DETAILS") return;
  (card as HTMLDetailsElement).open = open;
  bodySync.get(card)?.();
}

/** Closed code cards own only a summary and plain state, never hidden code DOM. */
export function attachToolCardBody(
  card: HTMLDetailsElement,
  render: () => HTMLElement,
): void {
  let body: HTMLElement | null = null;
  let disposed = false;
  const sync = () => {
    if (disposed) return;
    if (card.open && !body) {
      body = render();
      card.append(body);
      const state = collapsedBodyState.get(card);
      if (state) restoreToolCardState(body, state);
      collapsedBodyState.delete(card);
    } else if (!card.open && body) {
      collapsedBodyState.set(card, captureToolCardState(body));
      disposeCardResources(body);
      body.remove();
      body = null;
    }
  };
  bodySync.set(card, sync);
  card.addEventListener("toggle", sync);
  onCardDispose(card, () => {
    disposed = true;
    bodySync.delete(card);
    card.removeEventListener("toggle", sync);
    body = null;
    collapsedBodyState.delete(card);
  });
  sync();
}
