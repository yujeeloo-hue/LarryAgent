import { el } from "./render.js";
import { formatTokenCount } from "./reasoningBlock.js";

export type ContextGaugeSource = "provider" | "estimate";

export interface ContextGaugeValue {
  usedTokens: number;
  cachedTokens?: number;
  source: ContextGaugeSource;
}

export interface ContextGauge {
  attachRing(host: HTMLElement): void;
  attachTooltip(host: HTMLElement): void;
  setUsage(value: ContextGaugeValue | null): void;
  setLimit(limitTokens: number): void;
}

const RATIO_WARNING = 0.75;
const RATIO_CRITICAL = 0.9;
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 128_000;

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_RADIUS = 15.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

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

export function contextGaugeRatio(
  usedTokens: number,
  limitTokens: number,
): number {
  if (!(usedTokens > 0) || !(limitTokens > 0)) return 0;
  return Math.min(1, Math.max(0, usedTokens / limitTokens));
}

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
