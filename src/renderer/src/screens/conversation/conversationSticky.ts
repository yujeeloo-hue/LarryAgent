/** Turn layout: prompt / Plan segments + flow content. Historical "sticky"
 * names are kept for append-host compatibility; these no longer pin on scroll. */
export const TURN_CLASS = "conversation-turn";
export const STICKY_SEGMENT_CLASS = "conversation-sticky-segment";
export const STICKY_ITEM_CLASS = "conversation-sticky-item";
export const FLOW_CLASS = "conversation-flow";
/** Marks the latest turn for streaming / tool append hosting (not a sticky gate). */
export const LATEST_TURN_CLASS = "is-latest";

/** Legacy + current wrappers unwrapped during flatten. */
export const STICKY_UNWRAP_SELECTOR = [
  ".conversation-user-sticky-scope",
  ".conversation-user-sticky",
  ".conversation-turn-body",
  ".conversation-plan-sticky-scope",
  ".conversation-plan-sticky",
  ".conversation-pin-rail",
  `.${STICKY_SEGMENT_CLASS}`,
  `.${STICKY_ITEM_CLASS}`,
  `.${FLOW_CLASS}`,
].join(", ");

export type StickyKind = "user" | "plan";

/** User prompt row or Plan card — each starts its own chronological segment. */
export function stickyKindOf(el: HTMLElement): StickyKind | null {
  if (el.classList.contains("conversation-msg-user")) return "user";
  if (el.classList.contains("content-card-plan")) return "plan";
  return null;
}

/**
 * Pull each plan card out of its message body into the top-level sequence.
 * Preserves chronological order.
 */
export function extractPlanCardsToSiblings(
  nodes: HTMLElement[],
): HTMLElement[] {
  const out: HTMLElement[] = [];

  for (const node of nodes) {
    if (stickyKindOf(node) === "plan") {
      out.push(node);
      continue;
    }

    const plan = node.querySelector<HTMLElement>(".content-card-plan");
    if (!plan) {
      out.push(node);
      continue;
    }

    const msgBody = plan.closest<HTMLElement>(".conversation-msg-body");
    const article = plan.closest<HTMLElement>(".conversation-msg");
    if (!msgBody || !article || !node.contains(plan)) {
      out.push(node);
      continue;
    }

    const after: ChildNode[] = [];
    let sibling = plan.nextSibling;
    while (sibling) {
      const next = sibling.nextSibling;
      after.push(sibling);
      sibling = next;
    }
    for (const child of after) child.parentNode?.removeChild(child);
    plan.remove();

    if (msgBody.childElementCount > 0 || msgBody.textContent?.trim()) {
      out.push(node === article ? article : node);
    } else if (node !== article) {
      article.remove();
      if (node.childElementCount > 0) out.push(node);
    }

    out.push(plan);

    if (after.length > 0) {
      const cont = document.createElement("article");
      cont.className = article.className;
      const sourceId = article.dataset.messageId;
      if (sourceId) cont.dataset.messageContinuation = sourceId;
      const body = document.createElement("div");
      body.className = "conversation-msg-body";
      for (const child of after) body.append(child);
      cont.append(body);
      out.push(cont);
    }
  }

  return out;
}

/**
 * Each prompt / Plan owns following flow until the next segment. Keeping these
 * boundaries lets streaming tools append after the latest Plan, in order.
 */
export function buildStickySegments(nodes: HTMLElement[]): HTMLElement[] {
  if (nodes.length === 0) return [];

  const children: HTMLElement[] = [];
  let segment: HTMLElement | null = null;
  let flow: HTMLElement | null = null;

  const ensureLeadingFlow = (): HTMLElement => {
    if (flow && !segment) return flow;
    flow = document.createElement("div");
    flow.className = FLOW_CLASS;
    children.push(flow);
    return flow;
  };

  const startSegment = (stickyNode: HTMLElement, kind: StickyKind): void => {
    segment = document.createElement("div");
    segment.className = STICKY_SEGMENT_CLASS;

    const item = document.createElement("div");
    item.className = `${STICKY_ITEM_CLASS} ${STICKY_ITEM_CLASS}--${kind}`;
    item.append(stickyNode);
    segment.append(item);

    flow = document.createElement("div");
    flow.className = FLOW_CLASS;
    segment.append(flow);

    children.push(segment);
  };

  for (const node of nodes) {
    const kind = stickyKindOf(node);
    if (kind) {
      startSegment(node, kind);
      continue;
    }
    if (!flow) ensureLeadingFlow();
    flow!.append(node);
  }

  // Keep empty segment flows — streaming / tools append into the latest
  // segment's flow; without it, content can land before the Plan.

  return children;
}

/** True when a plan card is not wrapped in a sticky item yet. */
export function hasUnwrappedPlan(root: ParentNode): boolean {
  for (const plan of root.querySelectorAll<HTMLElement>(".content-card-plan")) {
    if (!plan.closest(`.${STICKY_ITEM_CLASS}`)) return true;
  }
  return false;
}
