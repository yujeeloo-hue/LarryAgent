import {
  contextUsageRatio,
  formatContextUsageLabel,
  normalizeContextUsage,
  type ContextUsage,
} from "../contextUsage.js";
import { ContextUsageTooltipView } from "./ContextUsageTooltipView.js";
import "./task-composer.css";

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_RADIUS = 15.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export class ComposerSendButtonView {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  private readonly ringProgress: SVGCircleElement;
  private readonly tooltip: ContextUsageTooltipView;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "composer-send-wrap";

    const ring = document.createElementNS(SVG_NS, "svg");
    ring.setAttribute("class", "context-usage-ring");
    ring.setAttribute("viewBox", "0 0 36 36");
    ring.setAttribute("aria-hidden", "true");

    const track = document.createElementNS(SVG_NS, "circle");
    track.setAttribute("class", "context-usage-track");
    track.setAttribute("cx", "18");
    track.setAttribute("cy", "18");
    track.setAttribute("r", String(RING_RADIUS));
    track.setAttribute("fill", "none");

    this.ringProgress = document.createElementNS(SVG_NS, "circle");
    this.ringProgress.setAttribute("class", "context-usage-progress");
    this.ringProgress.setAttribute("cx", "18");
    this.ringProgress.setAttribute("cy", "18");
    this.ringProgress.setAttribute("r", String(RING_RADIUS));
    this.ringProgress.setAttribute("fill", "none");
    this.ringProgress.setAttribute(
      "stroke-dasharray",
      String(RING_CIRCUMFERENCE),
    );
    this.ringProgress.setAttribute(
      "stroke-dashoffset",
      String(RING_CIRCUMFERENCE),
    );
    this.ringProgress.setAttribute("stroke-linecap", "round");
    ring.append(track, this.ringProgress);

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "composer-send-btn";
    this.button.setAttribute("aria-label", "Send");
    this.button.disabled = true;

    this.tooltip = new ContextUsageTooltipView(this.root, this.button);
    this.root.append(ring, this.button, this.tooltip.root);
  }

  setContextUsage(usage: ContextUsage): void {
    const normalized = normalizeContextUsage(usage);
    const ratio = contextUsageRatio(normalized);
    this.ringProgress.setAttribute(
      "stroke-dashoffset",
      String(RING_CIRCUMFERENCE * (1 - ratio)),
    );
    this.ringProgress.classList.toggle(
      "is-warning",
      ratio >= 0.75 && ratio < 0.9,
    );
    this.ringProgress.classList.toggle("is-critical", ratio >= 0.9);
    const label = formatContextUsageLabel(normalized);
    this.tooltip.setUsage(normalized, label);
    this.root.setAttribute("aria-label", label);
  }

  destroy(): void {
    this.tooltip.destroy();
  }

  setRunning(running: boolean): void {
    this.root.classList.toggle("is-running", running);
  }

  setStop(stop: boolean): void {
    this.button.classList.toggle("is-stop", stop);
  }
}
