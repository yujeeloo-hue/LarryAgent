import { ChevronUp } from "lucide";
import { contextCacheHitRatio, contextUsageRows, formatContextUsageLabel, type ContextUsage } from "../contextUsage.js";
import { createLucideIcon } from "../originalIcons.js";

const tokenCount = new Intl.NumberFormat();
const percentage = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
let nextTooltipId = 0;

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
  className = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function formatPercentage(ratio: number): string {
  return ratio > 0 && ratio < 0.0005 ? `<${percentage.format(0.001)}` : percentage.format(ratio);
}

export class ContextUsageTooltipView {
  readonly root = document.createElement("div");
  private readonly compactSummary = textElement("span", "", "context-tip-compact");
  private readonly title = textElement("strong", "Context usage");
  private readonly toggle = document.createElement("button");
  private readonly chevron = createLucideIcon(ChevronUp, { size: 14 });
  private readonly details = document.createElement("div");
  private readonly content = textElement("div", "", "context-tip-content");
  private readonly source = textElement("span", "", "context-tip-source");
  private readonly utilization = textElement("strong", "");
  private readonly used = textElement("strong", "");
  private readonly limit = textElement("span", "");
  private readonly chart = textElement("div", "", "context-tip-stack");
  private readonly tableBody = document.createElement("tbody");
  private readonly tokenHeading = textElement("th", "Tokens");
  private readonly cacheRate = textElement("strong", "");
  private readonly cacheBasis = textElement("span", "");
  private readonly cache = textElement("footer", "", "context-tip-cache");
  private usageKey = "";
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private openListeners: AbortController | undefined;
  private activeRow: HTMLTableRowElement | undefined;
  private activeSegment: HTMLElement | undefined;
  private expanded = false;
  private restoringFocus = false;
  private panelMotion: Animation | undefined;
  private detailMotions: Animation[] = [];

  constructor(
    private readonly anchor: HTMLElement,
    private readonly sendButton: HTMLButtonElement,
  ) {
    this.root.id = `context-usage-tooltip-${++nextTooltipId}`;
    this.root.className = "context-usage-tooltip";
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "Context usage");
    this.root.setAttribute("popover", "manual");
    this.root.hidden = true;
    this.compactSummary.id = `${this.root.id}-summary`;
    this.details.id = `${this.root.id}-details`;
    sendButton.setAttribute("aria-describedby", this.compactSummary.id);
    this.toggle.type = "button";
    this.toggle.className = "context-tip-toggle";
    this.toggle.setAttribute("aria-controls", this.details.id);
    this.toggle.append(this.chevron);
    this.toggle.addEventListener("click", () => this.toggleDetails());

    const header = textElement("div", "", "context-tip-header");
    header.append(this.compactSummary, this.title, this.source);
    const summary = textElement("div", "", "context-tip-summary");
    const usedPercentage = document.createElement("span");
    usedPercentage.className = "context-tip-percent";
    usedPercentage.append(this.utilization, " used");
    const total = textElement("span", "", "context-tip-total");
    total.append(this.used, this.limit);
    summary.append(usedPercentage, total);
    this.chart.setAttribute("aria-hidden", "true");

    const table = document.createElement("table");
    table.className = "context-tip-breakdown";
    const headingRow = document.createElement("tr");
    for (const cell of [textElement("th", "Source"), this.tokenHeading, textElement("th", "% of window")]) {
      cell.scope = "col";
      headingRow.append(cell);
    }
    const heading = document.createElement("thead");
    heading.append(headingRow);
    table.append(heading, this.tableBody);

    const cacheValue = document.createElement("span");
    cacheValue.append(this.cacheRate, this.cacheBasis);
    this.cache.append(textElement("span", "Prompt cache hit"), cacheValue);
    const footer = textElement("div", "", "context-tip-footer");
    footer.append(this.cache);
    this.details.append(summary, this.chart, table, footer);
    this.content.append(header, this.details);
    this.root.append(this.content, this.toggle);
    this.setExpanded(false);
    this.setUsage({ usedTokens: 0, limitTokens: 128_000 });

    anchor.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") this.show();
    });
    anchor.addEventListener("pointerleave", () => this.scheduleClose());
    anchor.addEventListener("focusin", () => {
      if (!this.restoringFocus) this.show();
    });
    anchor.addEventListener("focusout", () => this.scheduleClose());
    this.root.addEventListener("pointerenter", () => this.cancelClose());
    this.root.addEventListener("pointerleave", () => this.scheduleClose());
  }

  setUsage(usage: ContextUsage, label = formatContextUsageLabel(usage)): void {
    const key = JSON.stringify(usage);
    if (this.usageKey === key) return;
    this.usageKey = key;
    this.compactSummary.textContent = label;
    this.source.textContent = usage.inputTokens === null
      ? "Provider total"
      : usage.usedTokens > 0 && usage.source === "estimate" ? "Estimated" : "";
    this.source.hidden = !this.expanded || !this.source.textContent;
    this.utilization.textContent = formatPercentage(usage.usedTokens / usage.limitTokens);
    this.used.textContent = tokenCount.format(Math.round(usage.usedTokens));
    this.limit.textContent = ` / ${tokenCount.format(Math.round(usage.limitTokens))} tokens`;

    const cache = contextCacheHitRatio(usage);
    this.cacheRate.textContent = cache === undefined ? "—" : formatPercentage(cache);
    this.cacheBasis.textContent = cache === undefined ? "" : " of input";
    this.cache.hidden = usage.usedTokens <= 0;

    const { occupied, estimated } = contextUsageRows(usage);
    const rows = [...occupied, { label: "Available", tokens: Math.max(0, Math.round(usage.limitTokens - usage.usedTokens)) }];
    this.tokenHeading.textContent = estimated ? "Est. tokens" : "Tokens";
    this.highlight();
    this.chart.replaceChildren();
    this.tableBody.replaceChildren();
    rows.forEach((part, index) => {
      const remaining = index === rows.length - 1;
      const tone = occupied.length > 1 ? 62 + 38 * index / (occupied.length - 1) : 100;
      const accent = `color-mix(in oklab, var(--accent) ${tone}%, black)`;
      const row = document.createElement("tr");
      row.classList.toggle("context-tip-available", remaining);
      row.style.setProperty("--context-tip-color", remaining ? "var(--fg-dim)" : accent);
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.append(textElement("span", part.label, "context-tip-label"));
      row.append(
        heading,
        textElement("td", tokenCount.format(part.tokens)),
        textElement("td", formatPercentage(part.tokens / usage.limitTokens)),
      );
      this.tableBody.append(row);
      let segment: HTMLElement | undefined;
      if (part.tokens > 0) {
        segment = textElement("span", "", "context-tip-segment");
        segment.style.flexGrow = String(part.tokens);
        segment.style.backgroundColor = remaining ? "var(--context-tip-track)" : accent;
        this.chart.append(segment);
      }
      for (const target of segment ? [row, segment] : [row]) {
        target.addEventListener("pointerenter", () => this.highlight(row, segment));
        target.addEventListener("pointerleave", () => this.highlight());
      }
    });
    if (!this.root.hidden) {
      this.stopMotion();
      this.position();
    }
  }

  destroy(): void {
    this.hide();
  }

  private highlight(row?: HTMLTableRowElement, segment?: HTMLElement): void {
    this.activeRow?.classList.remove("is-active");
    this.activeSegment?.classList.remove("is-active");
    this.activeRow = row;
    this.activeSegment = segment;
    row?.classList.add("is-active");
    segment?.classList.add("is-active");
    this.chart.classList.toggle("has-active", segment !== undefined);
  }

  private show(): void {
    this.cancelClose();
    if (!this.root.hidden || !this.root.isConnected) return;
    this.root.hidden = false;
    this.root.showPopover?.();
    const listeners = new AbortController();
    this.openListeners = listeners;
    const options = { signal: listeners.signal };
    this.root.ownerDocument.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.hide(true);
    }, options);
    this.root.ownerDocument.addEventListener("pointerdown", (event) => {
      if (!event.composedPath().includes(this.anchor)) this.hide();
    }, { ...options, capture: true });
    this.root.ownerDocument.defaultView?.addEventListener("resize", () => {
      this.stopMotion();
      this.position();
    }, options);
    this.position();
  }

  private hide(restoreFocus = false): void {
    const returnFocus = restoreFocus && this.root.contains(this.root.ownerDocument.activeElement);
    this.restoringFocus = returnFocus;
    this.cancelClose();
    this.stopMotion();
    this.openListeners?.abort();
    this.openListeners = undefined;
    if (!this.root.hidden) this.root.hidePopover?.();
    this.root.hidden = true;
    this.setExpanded(false);
    this.highlight();
    if (returnFocus) this.sendButton.focus({ preventScroll: true });
    this.restoringFocus = false;
  }

  private cancelClose(): void {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  private scheduleClose(): void {
    this.cancelClose();
    if (this.root.hidden || this.expanded) return;
    this.closeTimer = setTimeout(() => {
      const focused = this.root.ownerDocument.activeElement;
      if (!this.anchor.matches(":hover") && !this.root.matches(":hover") && !this.anchor.contains(focused)) {
        if (this.panelMotion) this.scheduleClose();
        else this.hide();
      }
    }, 160);
  }

  private setExpanded(open: boolean): void {
    this.expanded = open;
    this.root.classList.toggle("is-expanded", open);
    this.content.scrollTop = 0;
    this.compactSummary.hidden = open;
    this.title.hidden = !open;
    this.source.hidden = !open || !this.source.textContent;
    this.details.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
    this.toggle.setAttribute("aria-label", open ? "Hide context details" : "Show context details");
  }

  private stopMotion(): void {
    this.panelMotion?.cancel();
    for (const motion of this.detailMotions) motion.cancel();
    this.panelMotion = undefined;
    this.detailMotions = [];
    this.root.classList.remove("is-animating");
  }

  private toggleDetails(): void {
    this.cancelClose();
    const win = this.root.ownerDocument.defaultView;
    const canAnimate = typeof this.root.animate === "function" &&
      win !== null && !win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const frame = (): Keyframe => {
      const { width, height, left, top } = this.root.getBoundingClientRect();
      const style = win?.getComputedStyle(this.root);
      return {
        width: `${width}px`,
        height: `${height}px`,
        left: `${left}px`,
        top: `${top}px`,
        paddingTop: style?.paddingTop,
        paddingBottom: style?.paddingBottom,
        "--context-tip-notch": style?.getPropertyValue("--context-tip-notch"),
      };
    };
    const before = canAnimate ? frame() : undefined;
    const beforeChevron = canAnimate ? win.getComputedStyle(this.chevron).transform : "";
    const beforeSide = this.root.dataset.side;
    this.stopMotion();
    const open = !this.expanded;
    this.setExpanded(open);
    this.highlight();
    this.position();
    if (!before || !win || this.root.hidden || this.root.dataset.side !== beforeSide) return;

    const after = frame();
    const duration = open ? 240 : 200;
    this.root.classList.add("is-animating");
    const motion = this.root.animate([before, after], { duration, easing: "cubic-bezier(.25,.8,.25,1)" });
    this.panelMotion = motion;
    motion.onfinish = () => {
      if (this.panelMotion !== motion) return;
      this.panelMotion = undefined;
      this.root.classList.remove("is-animating");
    };
    this.detailMotions = [
      (open ? this.details : this.compactSummary).animate(
        [{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: duration - 55, delay: 55, easing: "ease-out", fill: "backwards" },
      ),
      this.chevron.animate(
        [{ transform: beforeChevron }, { transform: win.getComputedStyle(this.chevron).transform }],
        { duration: 180, easing: "ease" },
      ),
    ];
  }

  private position(): void {
    const win = this.root.ownerDocument.defaultView;
    if (!win) return;
    if (this.anchor.getClientRects().length === 0) {
      this.hide();
      return;
    }
    const anchor = this.anchor.getBoundingClientRect();
    const margin = 8;
    const gap = 10;
    const above = anchor.top - gap - margin;
    const below = win.innerHeight - anchor.bottom - gap - margin;
    // Both disclosure states use the roomier side, keeping the control next to the ring.
    const opensBelow = below > above;
    const space = Math.max(0, opensBelow ? below : above);
    if (space === 0) {
      this.hide();
      return;
    }
    const maxWidth = Math.min(344, win.innerWidth - 2 * margin);
    const right = Math.min(anchor.right, win.innerWidth - margin);
    const alignEnd = right - margin >= Math.min(maxWidth, 280);
    this.root.dataset.side = opensBelow ? "below" : "above";
    this.root.dataset.inline = alignEnd ? "end" : "start";
    this.root.style.maxWidth = `${alignEnd ? Math.min(maxWidth, right - margin) : maxWidth}px`;
    this.root.style.maxHeight = "";
    this.root.classList.remove("is-constrained");
    const { width, height } = this.root.getBoundingClientRect();
    const left = alignEnd
      ? right - width
      : Math.max(margin, Math.min(anchor.left, win.innerWidth - margin - maxWidth));
    this.root.classList.toggle("is-constrained", height > space);
    this.root.style.maxHeight = `${space}px`;
    this.root.style.left = `${left}px`;
    this.root.style.top = `${opensBelow ? anchor.bottom + gap : anchor.top - gap - Math.min(height, space)}px`;
    const notch = (anchor.left + anchor.right) / 2 - left;
    this.root.style.setProperty("--context-tip-notch", `${Math.max(19, Math.min(width - 19, notch))}px`);
  }
}
