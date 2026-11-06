/** Thinking's icon dock. Mirrored in relay/web/src/reasoningToolChips.ts. */
const SIZE = 24;
const INSET = 3;
const GAP = 5;
const DOCK_GAP = 12;
const LIMIT = 5;
const MOTION_MS = 360;
const BATCH_MS = 240;
const EASING = "cubic-bezier(.2,.75,.2,1)";

type Position = { x: number; width: number };
type Dock = {
  root: HTMLElement;
  tools: HTMLElement;
  lane: HTMLElement;
  count: HTMLElement;
  build: (hint: string) => HTMLElement;
  hints: string[];
  totalHints: number;
  nodes: Map<string, HTMLElement>;
  positions: Map<HTMLElement, Position>;
  animations: Map<HTMLElement, Animation>;
  phase: "live" | "draining" | "done";
  revision: number;
  painted: boolean;
  lastPaint: number;
  timer: ReturnType<typeof setTimeout> | null;
  observer: ResizeObserver | null;
  mountFrame: number | null;
};

const docks = new WeakMap<HTMLElement, Dock>();

function animated(dock: Dock): boolean {
  return dock.root.isConnected && typeof dock.lane.animate === "function" &&
    !(typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function cancelPending(dock: Dock): void {
  if (dock.mountFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(dock.mountFrame);
  dock.mountFrame = null;
  if (dock.timer !== null) clearTimeout(dock.timer);
  dock.timer = null;
  for (const animation of dock.animations.values()) animation.cancel();
  dock.animations.clear();
  for (const node of dock.lane.querySelectorAll<HTMLElement>("[data-retiring]")) node.remove();
}

function positionOf(dock: Dock, node: HTMLElement): Position {
  if (typeof node.getBoundingClientRect === "function" && dock.lane.clientWidth > 0) {
    const rect = node.getBoundingClientRect();
    return { x: rect.left - dock.lane.getBoundingClientRect().left, width: Math.max(SIZE, rect.width) };
  }
  return dock.positions.get(node) ?? { x: INSET, width: SIZE };
}

function move(dock: Dock, node: HTMLElement, from: Position, to: Position, duration: number): Promise<void> {
  dock.animations.get(node)?.cancel();
  dock.animations.delete(node);
  node.style.width = `${to.width}px`;
  node.style.transform = `translateX(${to.x}px)`;
  dock.positions.set(node, to);
  if (!duration) return Promise.resolve();
  const animation = node.animate([
    { transform: `translateX(${from.x}px)`, width: `${from.width}px` },
    { transform: `translateX(${to.x}px)`, width: `${to.width}px` },
  ], { duration, easing: EASING });
  dock.animations.set(node, animation);
  return animation.finished.catch(() => {}).then(() => {
    if (dock.animations.get(node) === animation) dock.animations.delete(node);
  });
}

function observe(dock: Dock): void {
  if (!dock.root.isConnected) {
    if (dock.mountFrame === null && typeof requestAnimationFrame === "function") {
      dock.mountFrame = requestAnimationFrame(() => {
        dock.mountFrame = null;
        if (dock.root.isConnected && dock.phase === "live") paint(dock, false);
      });
    }
    return;
  }
  if (dock.observer || typeof ResizeObserver === "undefined") return;
  dock.observer = new ResizeObserver(() => {
    if (!dock.root.isConnected) {
      dock.observer?.disconnect();
      dock.observer = null;
      cancelPending(dock);
      return;
    }
    if (dock.phase === "live") paint(dock, false);
  });
  dock.observer.observe(dock.lane);
}

function paint(dock: Dock, animate: boolean): void {
  if (dock.phase !== "live") return;
  observe(dock);
  const laneWidth = Math.max(SIZE, (dock.lane.clientWidth || 360) - INSET * 2);
  const newest = dock.hints.at(-1);
  let textWidth = SIZE;
  if (newest) {
    let node = dock.nodes.get(newest);
    if (!node) {
      node = dock.build(newest);
      dock.nodes.set(newest, node);
      dock.lane.append(node);
    }
    const text = node.querySelector<HTMLElement>(".conversation-reasoning-chip-text");
    const measured = text?.scrollWidth || Array.from(text?.textContent ?? newest).length * 6;
    textWidth = Math.min(149, measured + 32);
  }
  const desiredWidth = textWidth;
  const countSpace = Math.max(20, (String(dock.totalHints).length + 1) * 6) + GAP;
  const fit = (reserveCount: boolean): string[] => {
    const available = Math.max(SIZE, laneWidth - (reserveCount ? countSpace : 0));
    textWidth = Math.max(SIZE, Math.min(desiredWidth, available - SIZE - GAP - DOCK_GAP));
    let fitted = dock.hints.slice(-LIMIT);
    const rowWidth = (length: number): number => textWidth + Math.max(0, length - 1) * (SIZE + GAP) + (length > 1 ? DOCK_GAP : 0);
    while (fitted.length > 1 && rowWidth(fitted.length) > available) fitted = fitted.slice(1);
    return fitted;
  };
  const needsCount = dock.totalHints > Math.min(LIMIT, dock.hints.length);
  let hints = fit(needsCount);
  if (!needsCount && dock.totalHints > hints.length) hints = fit(true);
  const keep = new Set(hints);
  const duration = animate && animated(dock) ? MOTION_MS : 0;
  for (const [hint, node] of dock.nodes) {
    if (keep.has(hint)) continue;
    dock.nodes.delete(hint);
    const from = positionOf(dock, node);
    node.dataset.retiring = "1";
    void move(dock, node, from, { x: -from.width - INSET, width: from.width }, duration).then(() => {
      node.remove();
      dock.positions.delete(node);
    });
  }
  let x = INSET;
  hints.forEach((hint, index) => {
    let node = dock.nodes.get(hint);
    const fresh = !node || !dock.positions.has(node);
    if (!node) {
      node = dock.build(hint);
      dock.nodes.set(hint, node);
    }
    dock.lane.append(node);
    const current = index === hints.length - 1;
    if (current && index > 0) x += DOCK_GAP;
    const to = { x, width: current ? textWidth : SIZE };
    const from = fresh && dock.painted
      ? { x: (dock.lane.clientWidth || 360) + INSET, width: to.width }
      : positionOf(dock, node);
    node.classList.toggle("is-icon-only", !current);
    node.classList.toggle("is-current", current);
    void move(dock, node, from, to, duration);
    x += to.width + GAP;
  });
  const latestNode = newest ? dock.nodes.get(newest) : undefined;
  // Anchor the count to the capsule itself, so it follows its animated width
  // instead of sitting at the far edge of the dock's reserved viewport.
  latestNode?.append(dock.count);
  const latestX = latestNode ? dock.positions.get(latestNode)?.x ?? 0 : 0;
  dock.lane.style.setProperty("--reasoning-dock-divider", `${latestX - 9}px`);
  dock.lane.classList.toggle("has-history", hints.length > 1);
  const retired = dock.totalHints - hints.length;
  dock.count.textContent = retired > 0 ? `+${retired}` : "";
  dock.count.hidden = retired <= 0;
  dock.painted = true;
  dock.lastPaint = Date.now();
}

function hide(dock: Dock): void {
  cancelPending(dock);
  dock.phase = "done";
  dock.root.dataset.toolChipsPhase = "done";
  dock.tools.hidden = true;
  dock.lane.replaceChildren();
  dock.nodes.clear();
  dock.positions.clear();
  dock.count.hidden = true;
  dock.observer?.disconnect();
  dock.observer = null;
}

export function setReasoningToolChips(root: HTMLElement, hints: readonly string[], build: Dock["build"]): void {
  let dock = docks.get(root);
  if (!dock) {
    const tools = root.querySelector<HTMLElement>(".conversation-reasoning-tools");
    const lane = root.querySelector<HTMLElement>(".conversation-reasoning-chips");
    const count = root.querySelector<HTMLElement>(".conversation-reasoning-chips-count");
    if (!tools || !lane || !count) return;
    dock = { root, tools, lane, count, build, hints: [], totalHints: 0, nodes: new Map(), positions: new Map(), animations: new Map(), phase: "live", revision: 0, painted: false, lastPaint: 0, timer: null, observer: null, mountFrame: null };
    docks.set(root, dock);
  }
  // Repeated hints move to the newest position; identical refreshes are idempotent.
  const ordered = Array.from(new Set([...hints].reverse())).reverse();
  dock.hints = ordered;
  dock.totalHints = hints.length;
  dock.tools.title = hints.join("\n");
  if (root.dataset.mode !== "streaming" || ordered.length === 0) {
    if (dock.phase !== "draining") hide(dock);
    return;
  }
  if (dock.phase !== "live") {
    dock.revision++;
    cancelPending(dock);
    dock.lane.replaceChildren();
    dock.nodes.clear();
    dock.positions.clear();
    dock.phase = "live";
    dock.painted = false;
  }
  root.dataset.toolChipsPhase = "live";
  dock.tools.hidden = false;
  const wait = animated(dock) && dock.painted ? Math.max(0, BATCH_MS - (Date.now() - dock.lastPaint)) : 0;
  if (dock.timer !== null) return;
  if (wait === 0) paint(dock, dock.painted);
  else dock.timer = setTimeout(() => {
    dock!.timer = null;
    paint(dock!, true);
  }, wait);
}

/** Drain the dock in order. Every chip moves together, so none crosses a neighbor. */
export function finishReasoningToolChips(root: HTMLElement): void {
  const dock = docks.get(root);
  if (!dock || dock.phase !== "live") return;
  if (dock.timer !== null) clearTimeout(dock.timer);
  dock.timer = null;
  paint(dock, false);
  const revision = ++dock.revision;
  dock.phase = "draining";
  root.dataset.toolChipsPhase = "draining";
  if (!animated(dock)) { hide(dock); return; }
  const queue = Array.from(dock.nodes.values())
    .map(node => ({ node, ...positionOf(dock, node) }))
    .sort((a, b) => a.x - b.x);
  void (async () => {
    let previous = 0;
    for (let index = 0; index < queue.length; index++) {
      if (dock.revision !== revision) return;
      const first = queue[index]!;
      const shift = first.x + first.width + GAP;
      await Promise.all(queue.slice(index).map(item => move(dock, item.node,
        { x: item.x - previous, width: item.width },
        { x: item.x - shift, width: item.width }, 240)));
      if (dock.revision !== revision) return;
      first.node.remove();
      previous = shift;
    }
    if (dock.revision === revision) hide(dock);
  })();
}

/** A new thinking segment may reuse this block before its previous drain finishes. */
export function resumeReasoningToolChips(root: HTMLElement): void {
  const dock = docks.get(root);
  if (!dock || dock.phase === "live") return;
  dock.revision++;
  cancelPending(dock);
  dock.lane.replaceChildren();
  dock.nodes.clear();
  dock.positions.clear();
  dock.phase = "live";
  dock.painted = false;
  dock.tools.hidden = dock.hints.length === 0;
  root.dataset.toolChipsPhase = "live";
  paint(dock, false);
}
