/**
 * Context usage ring — Mac-parity display of the session's context window
 * consumption: an SVG progress ring mounted around the composer's round
 * send/stop buttons (the toolbar send wrap on desktop + phones, the stop
 * wrap inside the mobile run pill). The send wrap also carries a hover
 * tooltip with the raw numbers (used / limit / cache); phones keep the
 * ring only — usage numbers are a desktop affordance.
 *
 * Data sources:
 *  - `session.contextUsage` from the getSession snapshot (initial mount)
 *  - `usage` / `context_display` stream events (live updates mid-turn)
 *  - limit from `listComposerOptions.defaults.contextLimitTokens` (128K
 *    fallback for older device builds)
 *
 * Provider-only rule (Mac parity): persisted estimate readings never drive
 * the ring — it stays empty until the first provider usage reading. The one
 * exception is a post-compact estimate, which paints grayed-out.
 */
import { el } from "./render.js";
import { formatTokenCount } from "./reasoningBlock.js";

export type ContextGaugeSource = "provider" | "estimate";

export interface ContextGaugeValue {
  usedTokens: number;
  cachedTokens?: number;
  source: ContextGaugeSource;
}

export interface ContextGauge {
  /**
   * Mount a progress ring into a button wrap (send / stop). Every attached
   * host repaints together; attaching to the same host twice is a no-op.
   */
  attachRing(host: HTMLElement): void;
  /** Mount the hover tooltip with raw numbers (desktop send wrap). */
  attachTooltip(host: HTMLElement): void;
  /** Repaint from a full value; ring progress empties when null/unknown. */
  setUsage(value: ContextGaugeValue | null): void;
  /** Change the denominator (device capability refresh); repaints. */
  setLimit(limitTokens: number): void;
}

const RATIO_WARNING = 0.75;
const RATIO_CRITICAL = 0.9;
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 128_000;

const SVG_NS = "http://www.w3.org/2000/svg";
/** Mac TaskComposerView ring geometry: 36-box, r 15.5 → dasharray = 2πr.
 *  r 15.5 (not 15) keeps the client's ~1px air gap between the ring's
 *  inner edge and the button face at every wrap size. */
const RING_RADIUS = 15.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Whether an incoming used-token count should replace the displayed value.
 * Bare 0 counts as "unknown / unset" — mid-stream zero usage events must not
 * clear a known-good reading (mirrors shouldAcceptUsedTokens).
 */
export function shouldAcceptGaugeTokens(
  previousUsed: number,
  incomingUsed: unknown,
): incomingUsed is number {
  if (typeof incomingUsed !== "number" || !Number.isFinite(incomingUsed)) {
    return false;
  }
  if (incomingUsed === 0 && previousUsed > 0) return false;
  return true;
}

/** Clamp ratio to [0, 1]; 0 when either side is not a positive number. */
export function contextGaugeRatio(
  usedTokens: number,
  limitTokens: number,
): number {
  if (!(usedTokens > 0) || !(limitTokens > 0)) return 0;
  return Math.min(1, Math.max(0, usedTokens / limitTokens));
}

/** Cached-share label for the tooltip: `31.0K (37%)` or `—`. */
export function formatGaugeCacheLabel(
  cachedTokens: number | undefined,
  usedTokens: number,
): string {
  if (
    typeof cachedTokens !== "number" ||
    !Number.isFinite(cachedTokens) ||
    cachedTokens <= 0 ||
    !(usedTokens > 0)
  ) {
    return "—";
  }
  const share = Math.round(
    (Math.min(cachedTokens, usedTokens) / usedTokens) * 100,
  );
  return `${formatTokenCount(cachedTokens)} (${share}%)`;
}

/** One mounted ring: the svg plus its progress circle (paint target). */
interface ContextRing {
  root: SVGSVGElement;
  progress: SVGCircleElement;
}

function circle(cls: string): SVGCircleElement {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("class", cls);
  c.setAttribute("cx", "18");
  c.setAttribute("cy", "18");
  c.setAttribute("r", String(RING_RADIUS));
  c.setAttribute("fill", "none");
  return c;
}

/** Ring svg (Mac context-usage-ring parity); caller mounts it in a wrap. */
function buildContextRing(): ContextRing {
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("class", "context-usage-ring");
  root.setAttribute("viewBox", "0 0 36 36");
  root.setAttribute("aria-hidden", "true");
  const progress = circle("context-usage-progress");
  progress.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
  progress.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE));
  progress.setAttribute("stroke-linecap", "round");
  root.append(circle("context-usage-track"), progress);
  return { root, progress };
}

/** Tooltip guts: rows + foot, repainted from the same value as the rings. */
interface ContextTooltip {
  root: HTMLElement;
  used: HTMLElement;
  limit: HTMLElement;
  cache: HTMLElement;
  foot: HTMLElement;
}

function buildContextTooltip(): ContextTooltip {
  const row = (label: string, value: HTMLElement) =>
    el("div", { class: "ctx-tip-row" }, el("span", {}, label), value);
  const used = el("b", { class: "mono" }, "—");
  const limit = el("b", { class: "mono" }, "—");
  const cache = el("b", { class: "mono" }, "—");
  const foot = el("div", { class: "ctx-tip-foot" }, "provider usage");
  const root = el("div", { class: "context-usage-tooltip", role: "tooltip" },
    row("Context used", used),
    row("Limit", limit),
    row("Prompt cache hit", cache),
    foot,
  );
  return { root, used, limit, cache, foot };
}


/**
 * Build the gauge. Rings mount into button wraps via attachRing (send wrap
 * on every breakpoint, stop wrap in the mobile run pill); attachTooltip adds
 * the desktop numbers card to the send wrap. All paints share one value.
 */
export function buildContextGauge(
  limitTokens: number = DEFAULT_CONTEXT_LIMIT_TOKENS,
): ContextGauge {
  let current: ContextGaugeValue | null = null;
  let limit = limitTokens > 0 ? limitTokens : DEFAULT_CONTEXT_LIMIT_TOKENS;
  const rings: ContextRing[] = [];
  const hosts = new Set<HTMLElement>();
  let tooltip: ContextTooltip | null = null;

  const paint = (): void => {
    const empty = !current;
    const ratio = current ? contextGaugeRatio(current.usedTokens, limit) : 0;
    const offset = RING_CIRCUMFERENCE * (1 - ratio);
    const warn = !empty && ratio >= RATIO_WARNING && ratio < RATIO_CRITICAL;
    const crit = !empty && ratio >= RATIO_CRITICAL;
    const estimate = !empty && current!.source === "estimate";
    for (const { progress } of rings) {
      progress.setAttribute("stroke-dashoffset", String(offset));
      progress.classList.toggle("is-empty", empty);
      progress.classList.toggle("is-warning", warn);
      progress.classList.toggle("is-critical", crit);
      progress.classList.toggle("is-estimate", estimate);
    }
    if (tooltip) {
      tooltip.used.textContent = empty ? "—" : formatTokenCount(current!.usedTokens);
      tooltip.limit.textContent = formatTokenCount(limit);
      tooltip.cache.textContent = empty
        ? "—"
        : formatGaugeCacheLabel(current!.cachedTokens, current!.usedTokens);
      tooltip.foot.replaceChildren();
      if (crit) {
        tooltip.foot.append(el("span", { class: "crit" }, "near context limit — auto-compact imminent"));
      } else if (warn) {
        tooltip.foot.append(el("span", { class: "warn" }, "high context usage"));
      } else if (estimate) {
        tooltip.foot.textContent = "estimated (post-compact)";
      } else {
        tooltip.foot.textContent = "provider usage";
      }
    }
  };

  return {
    attachRing(host) {
      if (hosts.has(host)) return;
      hosts.add(host);
      const ring = buildContextRing();
      rings.push(ring);
      host.prepend(ring.root);
      paint();
    },
    attachTooltip(host) {
      if (tooltip) {
        if (tooltip.root.parentElement !== host) host.append(tooltip.root);
        return;
      }
      tooltip = buildContextTooltip();
      host.append(tooltip.root);
      paint();
    },
    setUsage(value) {
      current = value;
      paint();
    },
    setLimit(limitTokens) {
      if (!(limitTokens > 0)) return;
      limit = limitTokens;
      paint();
    },
  };
}

/**
 * Session-snapshot hydration (Mac ConversationController parity): only
 * provider readings drive the gauge; persisted estimates are ignored.
 */
export function gaugeValueFromSessionContextUsage(usage: {
  usedTokens?: unknown;
  cachedTokens?: unknown;
  source?: unknown;
}): ContextGaugeValue | null {
  if (usage?.source !== "provider") return null;
  const used = usage.usedTokens;
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) {
    return null;
  }
  const cached = usage.cachedTokens;
  return {
    usedTokens: Math.max(0, used),
    ...(typeof cached === "number" && Number.isFinite(cached)
      ? { cachedTokens: Math.max(0, cached) }
      : {}),
    source: "provider",
  };
}

/**
 * usage / context_display stream event → gauge value (null when the event
 * carries no usable reading). Same merge rule as the Mac ring.
 */
export function gaugeValueFromStreamEvent(event: {
  type: string;
  promptTokens?: number;
  totalTokens?: number;
  usedTokens?: number;
  cachedTokens?: number;
  source?: string;
}): ContextGaugeValue | null {
  if (event.type === "context_display") {
    if (event.source !== "provider") return null;
    if (typeof event.usedTokens !== "number" || !Number.isFinite(event.usedTokens)) {
      return null;
    }
    return {
      usedTokens: Math.max(0, event.usedTokens),
      ...(typeof event.cachedTokens === "number" && Number.isFinite(event.cachedTokens)
        ? { cachedTokens: Math.max(0, event.cachedTokens) }
        : {}),
      source: "provider",
    };
  }
  // "usage": promptTokens preferred, totalTokens fallback (mid-stream
  // placeholder chunks with both empty resolve to null).
  const used =
    typeof event.promptTokens === "number" && event.promptTokens > 0
      ? event.promptTokens
      : typeof event.totalTokens === "number" && event.totalTokens > 0
        ? event.totalTokens
        : null;
  if (used == null) return null;
  return {
    usedTokens: used,
    ...(typeof event.cachedTokens === "number" && Number.isFinite(event.cachedTokens)
      ? { cachedTokens: Math.max(0, event.cachedTokens) }
      : {}),
    source: "provider",
  };
}
