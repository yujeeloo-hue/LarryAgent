import { createBrandIcon, matchModelBrand } from "../ui/modelBrand.js";
import {
  Braces,
  Check,
  Clock,
  Coins,
  Copy,
  createLucideIcon,
  ChevronsUpDown,
  Download,
  FileText,
  FolderOpen,
  Hourglass,
  MessageSquare,
  Pencil,
  RefreshCw,
  ScrollText,
  Send,
  Terminal,
  TriangleAlert,
  Wrench,
  type IconNode,
} from "../ui/originalIcons.js";
import {
  assignLanes,
  chooseRulerStep,
  computeTimeSpan,
  firstTickAtOrAfter,
  formatClock,
  formatDuration,
  formatRulerLabel,
  isTimelineRecordError,
  TIMELINE_TRACKS,
  trackOf,
  type TimelineBar,
  type TimelineTrackId,
} from "./timelineLayout.js";
import "./dev-tools.css";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Fixed left gutter for track labels (User / LLM / Tools / Aux). */
const GUTTER_W = 64;
const RULER_H = 26;
const LANE_H = 22;
const BAR_H = 14;
const BAR_Y_OFFSET = (LANE_H - BAR_H) / 2;
/** Visual floor so short calls stay visible and clickable. */
const BAR_MIN_W = 5;
/** Transparent hit zone: full lane height, generous horizontal hot zone. */
const HIT_MIN_W = 14;
const HIT_MIN_H_PAD = 2;
/** Pointer travel below this counts as a click, not a drag. */
const DRAG_THRESHOLD_PX = 6;
const MIN_VIEW_SPAN_MS = 50;
const ZOOM_FACTOR = 1.5;
const FIT_PAD_RATIO = 0.02;
const FIT_PAD_MIN_MS = 250;
/** Hard cap on rendered bars — a dev panel must not build 5000 nodes on a tick. */
const MAX_RENDER_BARS = 1_500;
/** Viewport transitions (zoom / refit) animate over this long. */
const VIEW_ANIM_MS = 260;
/**
 * Fit drift above this fraction of the view span counts as a discrete jump
 * rather than continuous growth.
 */
const FIT_ANIM_DRIFT = 0.35;
/**
 * A refit only glides when the timeline sat idle for at least this long —
 * animating while records keep arriving chases stale targets and stutters.
 */
const VIEW_ANIM_IDLE_MS = 5_000;

const LEGEND_ITEMS: Array<{ kind: string; label: string }> = [
  { kind: "is-user", label: "User" },
  { kind: "is-wait", label: "Wait" },
  { kind: "is-reasoning", label: "Reasoning" },
  { kind: "is-content", label: "Content" },
  { kind: "is-tools", label: "Tools" },
  { kind: "is-aux", label: "Aux" },
  { kind: "is-error", label: "Error" },
  { kind: "is-inflight", label: "In flight" },
];

type TimelineSnapshot = {
  records: LlmTimelineRecord[];
  truncatedCount: number;
};

/**
 * Detail → Timeline tab — SVG waterfall of the focused session's activity
 * for this app run (in-memory recording only), split into fixed tracks:
 * user prompts (client), chat LLM round-trips (server), tool executions
 * (client), auxiliary LLM calls. Real-time axis with wheel zoom
 * (cursor-anchored), drag pan, and Fit to restore the full-span view.
 */
export class TimelinePaneView {
  readonly root: HTMLElement;
  readonly refreshButton: HTMLButtonElement;
  readonly exportButton: HTMLButtonElement;
  readonly importButton: HTMLButtonElement;
  /** Cycles the Detail drawer between its two timeline heights. */
  readonly panelHeightButton: HTMLButtonElement;
  private readonly zoomOutButton: HTMLButtonElement;
  private readonly zoomInButton: HTMLButtonElement;
  private readonly fitButton: HTMLButtonElement;
  private readonly zoomLabel: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly rulerG: SVGGElement;
  private readonly trackG: SVGGElement;
  private readonly barsG: SVGGElement;
  /** Clip rect confining grid + bars to the time area (right of gutter). */
  private readonly areaClipRect: SVGRectElement;
  private readonly emptyEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly resizeObserver: ResizeObserver;

  private records: LlmTimelineRecord[] = [];
  private truncatedCount = 0;
  private selectedId: string | null = null;
  private viewStart = 0;
  /** Timeline zero = first record start (turn start); ruler labels are relative. */
  private timeZero = 0;
  /** In-flight viewport animation (zoom / refit); null when settled. */
  private viewAnim: {
    start0: number;
    span0: number;
    start1: number;
    span1: number;
    t0: number;
    rafId: number;
  } | null = null;
  /** Wall clock of the last record arrival — gates refit gliding. */
  private lastRecordChangeAt = 0;
  private viewSpan = 1_000;
  private keepFitted = true;
  /** Last seen tail record id — used to re-fit when new activity lands. */
  private lastTailId: string | null = null;
  private width = 0;
  private dragging = false;
  private didDrag = false;
  private dragStartX = 0;
  private dragViewStart = 0;
  /** Skips detail rebuilds when the selected record's visible data is unchanged. */
  private detailSignature: string | null = null;
  /** Non-null while showing an imported file instead of the live session. */
  private importedLabel: string | null = null;
  /** Fired when a bar is clicked open — shell may grow the drawer for it. */
  private barSelectHandler: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "timeline-pane";

    const toolbar = document.createElement("div");
    toolbar.className = "timeline-toolbar";

    this.statusEl = document.createElement("span");
    this.statusEl.className = "timeline-status";

    const legend = document.createElement("div");
    legend.className = "timeline-legend";
    for (const item of LEGEND_ITEMS) {
      const entry = document.createElement("span");
      // The kind lives on the item too: narrow panes drop whole entries, and
      // once the labels are gone a bare dot still needs its name on hover.
      entry.className = `timeline-legend-item ${item.kind}`;
      entry.title = item.label;
      const dot = document.createElement("span");
      dot.className = `timeline-legend-dot ${item.kind}`;
      const label = document.createElement("span");
      label.className = "timeline-legend-label";
      label.textContent = item.label;
      entry.append(dot, label);
      legend.append(entry);
    }

    const actions = document.createElement("div");
    actions.className = "timeline-toolbar-actions";

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "timeline-zoom-group";
    this.zoomOutButton = iconlessButton("−", "Zoom out");
    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "timeline-zoom-label";
    this.zoomInButton = iconlessButton("+", "Zoom in");
    zoomGroup.append(this.zoomOutButton, this.zoomLabel, this.zoomInButton);

    this.fitButton = iconlessButton("Fit", "Fit full timeline");
    this.panelHeightButton = document.createElement("button");
    this.panelHeightButton.type = "button";
    this.panelHeightButton.className = "timeline-action";
    this.panelHeightButton.title = "Toggle panel height (218 / 405 px)";
    this.panelHeightButton.setAttribute("aria-label", "Toggle panel height");
    this.panelHeightButton.append(
      createLucideIcon(ChevronsUpDown, { size: 14 }),
    );
    this.refreshButton = document.createElement("button");
    this.refreshButton.type = "button";
    this.refreshButton.className = "timeline-action";
    this.refreshButton.title = "Refresh";
    this.refreshButton.setAttribute("aria-label", "Refresh");
    this.refreshButton.append(createLucideIcon(RefreshCw, { size: 14 }));

    this.exportButton = document.createElement("button");
    this.exportButton.type = "button";
    this.exportButton.className = "timeline-action";
    this.exportButton.title = "Export timeline as JSON";
    this.exportButton.setAttribute("aria-label", "Export timeline as JSON");
    this.exportButton.append(createLucideIcon(Download, { size: 14 }));

    this.importButton = document.createElement("button");
    this.importButton.type = "button";
    this.importButton.className = "timeline-action";
    this.importButton.title = "Import timeline JSON";
    this.importButton.setAttribute("aria-label", "Import timeline JSON");
    this.importButton.append(createLucideIcon(FolderOpen, { size: 14 }));

    actions.append(
      zoomGroup,
      this.fitButton,
      this.panelHeightButton,
      this.exportButton,
      this.importButton,
      this.refreshButton,
    );
    toolbar.append(this.statusEl, legend, actions);

    const body = document.createElement("div");
    body.className = "timeline-body";

    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "timeline-viewport";

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("class", "timeline-svg");
    const defs = document.createElementNS(SVG_NS, "defs");
    const areaClipPath = document.createElementNS(SVG_NS, "clipPath");
    areaClipPath.setAttribute("id", "tl-area-clip");
    this.areaClipRect = document.createElementNS(SVG_NS, "rect");
    areaClipPath.append(this.areaClipRect);
    defs.append(areaClipPath);
    this.rulerG = document.createElementNS(SVG_NS, "g");
    this.trackG = document.createElementNS(SVG_NS, "g");
    this.barsG = document.createElementNS(SVG_NS, "g");
    // Grid + bars stay inside the time area — never under the gutter labels.
    this.rulerG.setAttribute("clip-path", "url(#tl-area-clip)");
    this.barsG.setAttribute("clip-path", "url(#tl-area-clip)");
    this.svg.append(defs, this.rulerG, this.trackG, this.barsG);
    this.viewportEl.append(this.svg);

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "timeline-empty";
    this.emptyEl.hidden = true;

    this.detailEl = document.createElement("aside");
    this.detailEl.className = "timeline-detail";
    this.detailEl.hidden = true;

    body.append(this.viewportEl, this.detailEl, this.emptyEl);
    this.root.append(toolbar, body);

    this.bindInteractions();
    this.resizeObserver = new ResizeObserver(() => {
      this.draw();
    });
    this.resizeObserver.observe(this.viewportEl);
  }

  /** New snapshot from the controller. Keeps the user viewport unless fitted. */
  render(snapshot: TimelineSnapshot): void {
    const tailId = snapshot.records.at(-1)?.id ?? null;
    // Idle gate for refit gliding: a new/removed block counts as activity.
    const activity =
      tailId !== this.lastTailId ||
      snapshot.records.length !== this.records.length;
    // New activity (new turn / iteration / tool call): snap back to fit so
    // the latest bars are always on screen, even after manual pan/zoom.
    if (tailId !== null && tailId !== this.lastTailId && !this.dragging) {
      this.keepFitted = true;
    }
    this.lastTailId = tailId;
    this.records = snapshot.records;
    this.truncatedCount = snapshot.truncatedCount;
    if (
      this.selectedId &&
      !this.records.some((record) => record.id === this.selectedId)
    ) {
      this.selectedId = null;
    }
    this.draw();
    // Stamped after drawing so this frame still sees the previous idle gap.
    if (activity) this.lastRecordChangeAt = Date.now();
  }

  /** Empty-state text; `null` hides the overlay. */
  setEmpty(text: string | null): void {
    this.emptyEl.textContent = text ?? "";
    this.emptyEl.hidden = text === null;
  }

  setRefreshBusy(busy: boolean): void {
    this.refreshButton.disabled = busy;
    this.refreshButton.classList.toggle("is-busy", busy);
  }

  /** Whether any record is still open (used to drive the RAF growth loop). */
  hasInFlight(): boolean {
    return this.records.some((record) => record.endedAt === null);
  }

  /** Current records + truncation count (used by the JSON export). */
  getSnapshot(): TimelineSnapshot {
    return { records: this.records, truncatedCount: this.truncatedCount };
  }

  /** Marks the view as showing imported data (`null` returns to live mode). */
  setImportedLabel(label: string | null): void {
    this.importedLabel = label;
    this.root.classList.toggle("is-imported", label !== null);
  }

  /** Bar click (selection opens) — e.g. to grow the drawer to fit detail. */
  onBarSelect(handler: () => void): void {
    this.barSelectHandler = handler;
  }

  /** Redraw with a fresh `now` (in-flight bars grow); called by the tick. */
  tick(): void {
    if (this.records.some((record) => record.endedAt === null)) {
      this.draw();
    }
  }

  // ——— Time ⇄ pixels —————————————————————————————————————————————

  private get timeAreaW(): number {
    return Math.max(this.width - GUTTER_W, 1);
  }

  private pxPerMs(): number {
    return this.timeAreaW / this.viewSpan;
  }

  private timeToX(ts: number): number {
    return GUTTER_W + (ts - this.viewStart) * this.pxPerMs();
  }

  // ——— Interactions ——————————————————————————————————————————————

  private bindInteractions(): void {
    this.zoomInButton.addEventListener("click", () => {
      this.zoomAt(this.width / 2, ZOOM_FACTOR);
    });
    this.zoomOutButton.addEventListener("click", () => {
      this.zoomAt(this.width / 2, 1 / ZOOM_FACTOR);
    });
    this.fitButton.addEventListener("click", () => {
      this.keepFitted = true;
      // Explicit user action always glides, regardless of the idle gate.
      const span = computeTimeSpan(this.records, Date.now());
      if (span) {
        const target = this.fitTarget(span);
        this.animateViewTo(target.start, target.span);
      } else {
        this.draw();
      }
    });

    this.viewportEl.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const rect = this.viewportEl.getBoundingClientRect();
        const localX = ev.clientX - rect.left;
        if (ev.shiftKey) {
          this.panByPixels(ev.deltaY);
          return;
        }
        if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
          this.panByPixels(ev.deltaX);
          return;
        }
        this.zoomAt(localX, Math.exp(-ev.deltaY * 0.0018));
      },
      { passive: false },
    );

    this.viewportEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement | null)?.closest("button")) return;
      this.cancelViewAnim();
      this.dragging = true;
      this.didDrag = false;
      this.dragStartX = ev.clientX;
      this.dragViewStart = this.viewStart;
    });

    this.viewportEl.addEventListener("pointermove", (ev) => {
      if (!this.dragging) return;
      const dx = ev.clientX - this.dragStartX;
      if (!this.didDrag && Math.abs(dx) < DRAG_THRESHOLD_PX) {
        return;
      }
      if (!this.didDrag) {
        // Capture only once a real drag starts: capturing at pointerdown
        // would retarget the following click to the viewport and bars
        // would never receive their click handlers.
        this.didDrag = true;
        this.viewportEl.setPointerCapture(ev.pointerId);
        this.viewportEl.classList.add("is-panning");
      }
      this.keepFitted = false;
      this.viewStart = this.dragViewStart - (dx / this.timeAreaW) * this.viewSpan;
      this.clampView();
      this.draw();
    });

    const endDrag = (ev: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.viewportEl.classList.remove("is-panning");
      if (this.viewportEl.hasPointerCapture(ev.pointerId)) {
        this.viewportEl.releasePointerCapture(ev.pointerId);
      }
      // A no-drag release is a click: select via coordinate hit-testing.
      // The RAF loop replaces bar nodes mid-click, so per-rect click
      // listeners would miss whenever a rebuild lands between down/up.
      if (!this.didDrag) this.selectAt(ev.clientX, ev.clientY);
      window.setTimeout(() => {
        this.didDrag = false;
      }, 0);
    };
    this.viewportEl.addEventListener("pointerup", endDrag);
    this.viewportEl.addEventListener("pointercancel", endDrag);
  }

  /**
   * Coordinate hit-test against the current records — independent of the
   * (constantly rebuilt) SVG nodes. Misses clear the selection.
   */
  private selectAt(clientX: number, clientY: number): void {
    const svgRect = this.svg.getBoundingClientRect();
    const x = clientX - svgRect.left;
    const y = clientY - svgRect.top;
    let next: string | null = null;
    if (x >= GUTTER_W) {
      const px = this.pxPerMs();
      const t = this.viewStart + (x - GUTTER_W) / px;
      const halfTolMs = HIT_MIN_W / 2 / px;
      const trackIndex = Math.floor((y - RULER_H) / LANE_H);
      const track = TIMELINE_TRACKS[trackIndex];
      if (track) {
        let best: { id: string; width: number } | null = null;
        const now = Date.now();
        for (const record of this.records) {
          if (trackOf(record) !== track.id) continue;
          const end = record.endedAt ?? now;
          if (t < record.startedAt - halfTolMs || t > end + halfTolMs) {
            continue;
          }
          const width = end - record.startedAt;
          if (!best || width < best.width) best = { id: record.id, width };
        }
        next = best?.id ?? null;
      }
    }
    if (next !== this.selectedId) {
      this.selectedId = next;
      this.draw();
      if (next !== null) this.barSelectHandler?.();
    }
  }

  private panByPixels(px: number): void {
    if (px === 0) return;
    this.keepFitted = false;
    this.viewStart -= (px / this.timeAreaW) * this.viewSpan;
    this.clampView();
    this.draw();
  }

  private zoomAt(anchorX: number, factor: number): void {
    if (this.timeAreaW <= 0) return;
    const anchorRatio = Math.min(
      Math.max((anchorX - GUTTER_W) / this.timeAreaW, 0),
      1,
    );
    const anchorT = this.viewStart + anchorRatio * this.viewSpan;
    const totalSpan = this.totalSpanMs();
    let span = this.viewSpan / factor;
    span = Math.min(
      Math.max(span, MIN_VIEW_SPAN_MS),
      Math.max(totalSpan * 4, MIN_VIEW_SPAN_MS),
    );
    const target = this.clampTarget(anchorT - anchorRatio * span, span);
    this.keepFitted = false;
    this.animateViewTo(target.start, target.span);
  }

  // ——— Viewport animation ——————————————————————————————————————————

  /** Smoothly transition the viewport (ease-out); snaps when already there. */
  private animateViewTo(start: number, span: number): void {
    this.cancelViewAnim();
    if (
      Math.abs(start - this.viewStart) < 1 &&
      Math.abs(span - this.viewSpan) < 1
    ) {
      this.draw();
      return;
    }
    const anim = {
      start0: this.viewStart,
      span0: this.viewSpan,
      start1: start,
      span1: span,
      t0: performance.now(),
      rafId: 0,
    };
    this.viewAnim = anim;
    const step = (now: number): void => {
      if (this.viewAnim !== anim) return;
      const p = Math.min((now - anim.t0) / VIEW_ANIM_MS, 1);
      const e = 1 - (1 - p) ** 3;
      this.viewStart = anim.start0 + (anim.start1 - anim.start0) * e;
      this.viewSpan = anim.span0 + (anim.span1 - anim.span0) * e;
      this.draw();
      if (p < 1) {
        anim.rafId = window.requestAnimationFrame(step);
      } else {
        this.viewAnim = null;
        this.draw();
      }
    };
    anim.rafId = window.requestAnimationFrame(step);
  }

  private cancelViewAnim(): void {
    const anim = this.viewAnim;
    if (!anim) return;
    this.viewAnim = null;
    window.cancelAnimationFrame(anim.rafId);
  }

  // ——— Layout / drawing ———————————————————————————————————————————

  private totalSpanMs(): number {
    const span = computeTimeSpan(this.records, Date.now());
    return span ? span.end - span.start : MIN_VIEW_SPAN_MS;
  }

  /** Clamp an arbitrary viewport target to the record span (pure). */
  private clampTarget(
    start: number,
    span: number,
  ): { start: number; span: number } {
    const spanInfo = computeTimeSpan(this.records, Date.now());
    if (!spanInfo) return { start, span };
    const minStart = spanInfo.start - span * 0.9;
    const maxStart = spanInfo.end - span * 0.1;
    const clamped =
      maxStart > minStart ? Math.min(Math.max(start, minStart), maxStart) : start;
    return { start: clamped, span };
  }

  private clampView(): void {
    const target = this.clampTarget(this.viewStart, this.viewSpan);
    this.viewStart = target.start;
    this.viewSpan = target.span;
  }

  /** Fit target: zero at the left edge, right side padded. */
  private fitTarget(span: {
    start: number;
    end: number;
  }): { start: number; span: number } {
    const pad = Math.max(
      (span.end - span.start) * FIT_PAD_RATIO,
      FIT_PAD_MIN_MS,
    );
    return { start: span.start, span: span.end - span.start + pad };
  }

  private draw(): void {
    const now = Date.now();
    const span = computeTimeSpan(this.records, now);
    this.width = this.viewportEl.clientWidth;
    if (!span || this.records.length === 0) {
      this.rulerG.replaceChildren();
      this.trackG.replaceChildren();
      this.barsG.replaceChildren();
      this.svg.setAttribute("height", "0");
      this.detailEl.hidden = true;
      this.zoomLabel.textContent = "—";
      this.updateStatus(0, null);
      return;
    }
    if (this.keepFitted) {
      const target = this.fitTarget(span);
      const drift =
        Math.abs(target.start - this.viewStart) +
        Math.abs(target.span - this.viewSpan);
      if (this.viewAnim) {
        // A glide is running: abandon it once the live fit target moves
        // away from its goal (never chase a stale target).
        const goalDrift =
          Math.abs(target.start - this.viewAnim.start1) +
          Math.abs(target.span - this.viewAnim.span1);
        if (goalDrift > this.viewSpan * FIT_ANIM_DRIFT) {
          this.cancelViewAnim();
        }
      }
      if (!this.viewAnim) {
        // Glide only for a discrete jump that follows an idle gap; during
        // continuous activity the viewport tracks growth frame by frame.
        const idleFor = now - this.lastRecordChangeAt;
        if (
          drift > this.viewSpan * FIT_ANIM_DRIFT &&
          idleFor >= VIEW_ANIM_IDLE_MS
        ) {
          this.animateViewTo(target.start, target.span);
        } else {
          this.viewStart = target.start;
          this.viewSpan = target.span;
        }
      }
    }
    this.timeZero = span.start;
    if (this.width <= 0) return;

    const visible =
      this.records.length > MAX_RENDER_BARS
        ? this.records.slice(this.records.length - MAX_RENDER_BARS)
        : this.records;

    // Fixed-height layout: ruler + one lane per track, never growing.
    const barsByTrack = new Map<
      TimelineTrackId,
      ReturnType<typeof assignLanes<LlmTimelineRecord>>["bars"]
    >();
    for (const track of TIMELINE_TRACKS) {
      const grouped = visible.filter(
        (record) => trackOf(record) === track.id,
      );
      barsByTrack.set(track.id, assignLanes(grouped, now).bars);
    }

    // +1 so the bottom frame line lands exactly on the last row's edge —
    // extra padding there would make the Aux lane look taller than the rest.
    const height = RULER_H + TIMELINE_TRACKS.length * LANE_H + 1;
    this.svg.setAttribute("width", String(this.width));
    this.svg.setAttribute("height", String(height));
    this.areaClipRect.setAttribute("x", String(GUTTER_W));
    this.areaClipRect.setAttribute("y", "0");
    this.areaClipRect.setAttribute(
      "width",
      String(Math.max(this.width - GUTTER_W, 0)),
    );
    this.areaClipRect.setAttribute("height", String(height));
    this.drawRuler();
    this.drawTrackLanes();
    this.drawBars(barsByTrack);
    this.zoomLabel.textContent = formatDuration(this.viewSpan);
    this.zoomLabel.title = "Visible span";
    this.updateStatus(visible.length, span);
    this.drawDetail();
  }

  private drawRuler(): void {
    this.rulerG.replaceChildren();
    const step = chooseRulerStep(this.viewSpan, this.timeAreaW);
    const height = Number(this.svg.getAttribute("height")) || RULER_H;
    const viewEnd = this.viewStart + this.viewSpan;

    const baseline = document.createElementNS(SVG_NS, "line");
    baseline.setAttribute("class", "tl-baseline");
    baseline.setAttribute("x1", String(GUTTER_W));
    baseline.setAttribute("x2", String(this.width));
    baseline.setAttribute("y1", String(RULER_H - 0.5));
    baseline.setAttribute("y2", String(RULER_H - 0.5));
    this.rulerG.append(baseline);

    for (
      let ts = firstTickAtOrAfter(this.viewStart, step);
      ts <= viewEnd;
      ts += step
    ) {
      const x = this.timeToX(ts);
      const grid = document.createElementNS(SVG_NS, "line");
      grid.setAttribute("class", "tl-grid");
      grid.setAttribute("x1", String(x));
      grid.setAttribute("x2", String(x));
      grid.setAttribute("y1", String(RULER_H));
      grid.setAttribute("y2", String(height));
      this.rulerG.append(grid);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "tl-tick-label");
      label.setAttribute("x", String(x + 4));
      label.setAttribute("y", String(RULER_H - 8));
      label.textContent = formatRulerLabel(ts, step, this.timeZero);
      this.rulerG.append(label);
    }
  }

  /** Gutter labels, track separators and the gutter divider line. */
  private drawTrackLanes(): void {
    this.trackG.replaceChildren();
    const height = Number(this.svg.getAttribute("height")) || RULER_H;

    const gutterBg = document.createElementNS(SVG_NS, "rect");
    gutterBg.setAttribute("class", "tl-gutter-bg");
    gutterBg.setAttribute("x", "0");
    gutterBg.setAttribute("y", "0");
    gutterBg.setAttribute("width", String(GUTTER_W));
    gutterBg.setAttribute("height", String(height));
    this.trackG.append(gutterBg);

    // Bottom border closing the waterfall block.
    const bottom = document.createElementNS(SVG_NS, "line");
    bottom.setAttribute("class", "tl-baseline");
    bottom.setAttribute("x1", "0");
    bottom.setAttribute("x2", String(this.width));
    bottom.setAttribute("y1", String(height - 0.5));
    bottom.setAttribute("y2", String(height - 0.5));
    this.trackG.append(bottom);

    const divider = document.createElementNS(SVG_NS, "line");
    divider.setAttribute("class", "tl-track-divider");
    divider.setAttribute("x1", String(GUTTER_W - 0.5));
    divider.setAttribute("x2", String(GUTTER_W - 0.5));
    divider.setAttribute("y1", String(0));
    divider.setAttribute("y2", String(height));
    this.trackG.append(divider);

    let y = RULER_H;
    for (const track of TIMELINE_TRACKS) {
      if (track !== TIMELINE_TRACKS[0]) {
        const sep = document.createElementNS(SVG_NS, "line");
        sep.setAttribute("class", "tl-track-sep");
        sep.setAttribute("x1", "0");
        sep.setAttribute("x2", String(this.width));
        sep.setAttribute("y1", String(y - 0.5));
        sep.setAttribute("y2", String(y - 0.5));
        this.trackG.append(sep);
      }

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "tl-track-label");
      label.setAttribute("x", "10");
      label.setAttribute("y", String(y + LANE_H / 2 + 3.5));
      label.textContent = track.label;
      this.trackG.append(label);

      y += LANE_H;
    }
  }

  private drawBars(
    trackYields: Map<TimelineTrackId, TimelineBar<LlmTimelineRecord>[]>,
  ): void {
    this.barsG.replaceChildren();
    const pxPerMs = this.pxPerMs();

    let trackIndex = 0;
    for (const track of TIMELINE_TRACKS) {
      const bars = trackYields.get(track.id) ?? [];
      const rowTop = RULER_H + trackIndex * LANE_H;
      const laneY = rowTop + BAR_Y_OFFSET;
      for (const bar of bars) {
        const x = this.timeToX(bar.start);
        const rawW = (bar.end - bar.start) * pxPerMs;
        const w = Math.max(rawW, BAR_MIN_W);
        const x0 = Math.max(x, -w);
        const x1 = Math.min(x + w, this.width + w);

          const rect = document.createElementNS(SVG_NS, "rect");
          rect.setAttribute("class", this.barClasses(track.id, bar.record));
          rect.setAttribute("x", String(x0));
          rect.setAttribute("y", String(laneY));
          rect.setAttribute("width", String(Math.max(x1 - x0, BAR_MIN_W)));
          rect.setAttribute("height", String(BAR_H));
          rect.setAttribute("rx", "3");
          this.barsG.append(rect);

          // LLM streaming bars: phase segmentation — wait (request → first
          // server event), reasoning stream, content stream; a dim base bar
          // covers the full round-trip (gaps + minimum width). Segments are
          // clipped to the base's rounded rect so bar ends stay round.
          const record = bar.record;
          if (
            record.kind === "llm" &&
            record.stream &&
            record.firstEventAt !== undefined &&
            !record.error &&
            record.doneReason !== "error"
          ) {
            const px = this.pxPerMs();
            rect.setAttribute(
              "class",
              `${this.barClasses(track.id, record)} is-base`,
            );

            const baseW = Math.max(x1 - x0, BAR_MIN_W);
            const clipId = `tl-clip-${record.id}`;
            const defs = document.createElementNS(SVG_NS, "defs");
            const clipPath = document.createElementNS(SVG_NS, "clipPath");
            clipPath.setAttribute("id", clipId);
            const clipRect = document.createElementNS(SVG_NS, "rect");
            clipRect.setAttribute("x", String(x0));
            clipRect.setAttribute("y", String(laneY));
            clipRect.setAttribute("width", String(baseW));
            clipRect.setAttribute("height", String(BAR_H));
            clipRect.setAttribute("rx", "3");
            clipPath.append(clipRect);
            defs.append(clipPath);

            const segG = document.createElementNS(SVG_NS, "g");
            segG.setAttribute("clip-path", `url(#${clipId})`);
            segG.append(defs);

            this.appendPhaseRect(
              segG,
              "tl-bar is-wait",
              x,
              laneY,
              (record.firstEventAt - bar.start) * px,
            );
            if (record.reasoningStartAt !== undefined) {
              const end =
                record.reasoningEndAt ??
                (record.endedAt === null ? bar.end : record.reasoningStartAt);
              this.appendPhaseRect(
                segG,
                "tl-bar is-reasoning",
                x + (record.reasoningStartAt - bar.start) * px,
                laneY,
                (end - record.reasoningStartAt) * px,
              );
            }
            if (record.contentStartAt !== undefined) {
              const end =
                record.contentEndAt ??
                (record.endedAt === null ? bar.end : record.contentStartAt);
              this.appendPhaseRect(
                segG,
                "tl-bar is-content",
                x + (record.contentStartAt - bar.start) * px,
                laneY,
                (end - record.contentStartAt) * px,
              );
            }
            this.barsG.append(segG);
            // Phase segments are clipped per-piece; selection needs one
            // coherent white-stroke + glow outline across the whole bar.
            if (record.id === this.selectedId) {
              const outline = document.createElementNS(SVG_NS, "rect");
              outline.setAttribute("class", "tl-select-outline");
              outline.setAttribute("x", String(x0));
              outline.setAttribute("y", String(laneY));
              outline.setAttribute("width", String(baseW));
              outline.setAttribute("height", String(BAR_H));
              outline.setAttribute("rx", "3");
              this.barsG.append(outline);
            }
          }

          const hit = document.createElementNS(SVG_NS, "rect");
          hit.setAttribute("class", "tl-hit");
          hit.setAttribute(
            "x",
            String(
              Math.max(x - (HIT_MIN_W - Math.min(rawW, HIT_MIN_W)) / 2, 0),
            ),
          );
          hit.setAttribute(
            "y",
            String(Math.max(rowTop - HIT_MIN_H_PAD, RULER_H)),
          );
          hit.setAttribute("width", String(Math.max(rawW, HIT_MIN_W)));
          hit.setAttribute("height", String(LANE_H + HIT_MIN_H_PAD * 2));
          hit.setAttribute("data-id", record.id);
          const tooltip = document.createElementNS(SVG_NS, "title");
          tooltip.textContent = barTitle(record);
          hit.append(tooltip);
          this.barsG.append(hit);
      }
      trackIndex += 1;
    }
  }

  /** Phase segment inside an LLM bar (wait / reasoning / content). */
  private appendPhaseRect(
    target: SVGGElement,
    cls: string,
    x: number,
    y: number,
    wPx: number,
  ): void {
    if (!(wPx > 0)) return;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("class", cls);
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(Math.max(wPx, 2)));
    rect.setAttribute("height", String(BAR_H));
    rect.setAttribute("rx", "1");
    target.append(rect);
  }

  private barClasses(track: TimelineTrackId, record: LlmTimelineRecord): string {
    const classes = ["tl-bar", `is-${track}`];
    if (isTimelineRecordError(record)) {
      classes.push("is-error");
    }
    if (record.endedAt === null) classes.push("is-inflight");
    if (record.id === this.selectedId) classes.push("is-selected");
    return classes.join(" ");
  }

  private updateStatus(
    rendered: number,
    span: { start: number; end: number } | null,
  ): void {
    if (!span) {
      this.statusEl.textContent = "";
      return;
    }
    const totalLlm = this.records.reduce(
      (acc, record) =>
        record.kind === "llm" ? acc + (record.durationMs ?? 0) : acc,
      0,
    );
    const totalTools = this.records.reduce(
      (acc, record) =>
        record.kind === "tool" ? acc + (record.durationMs ?? 0) : acc,
      0,
    );
    const parts = [
      `${this.records.length} records`,
      `span ${formatDuration(span.end - span.start)}`,
      `LLM ${formatDuration(totalLlm)}`,
    ];
    if (totalTools > 0) parts.push(`Tools ${formatDuration(totalTools)}`);
    if (this.records.length > rendered) {
      parts.push(`rendering latest ${rendered}`);
    }
    if (this.truncatedCount > 0) {
      parts.push(`truncated ${this.truncatedCount} oldest`);
    }
    if (this.importedLabel !== null) {
      parts.unshift(`imported: ${this.importedLabel}`);
    }
    this.statusEl.textContent = parts.join(" · ");
  }

  // ——— Detail panel ———————————————————————————————————————————————

  private drawDetail(): void {
    const record = this.records.find((item) => item.id === this.selectedId);
    if (!record) {
      this.detailEl.hidden = true;
      this.detailEl.replaceChildren();
      this.detailSignature = null;
      return;
    }
    // Skip rebuilds when nothing visible changed: the 500ms in-flight tick
    // must not reset raw-pane scroll positions. Raw payloads contribute
    // their length so streaming growth still triggers a rebuild.
    const signature = JSON.stringify(record, (key, value) =>
      typeof value === "string" && key.endsWith("Raw")
        ? value.length
        : value,
    );
    if (!this.detailEl.hidden && this.detailSignature === signature) return;

    this.detailEl.hidden = false;
    this.detailEl.replaceChildren();

    const head = document.createElement("div");
    head.className = "timeline-detail-head";
    const title = document.createElement("span");
    title.className = "timeline-detail-title";
    const subtitle = document.createElement("span");
    subtitle.className = "timeline-detail-subtitle";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "timeline-detail-close";
    close.title = "Clear selection";
    close.setAttribute("aria-label", "Clear selection");
    close.textContent = "✕";
    close.addEventListener("click", () => {
      this.selectedId = null;
      this.draw();
    });
    head.append(title, subtitle, close);

    const grid = document.createElement("div");
    grid.className = "timeline-detail-grid";
    const cols: HTMLElement[] = [];
    const raws = document.createElement("div");
    raws.className = "timeline-detail-raws";
    const errEl =
      record.error !== undefined ? errorStrip(record.error) : null;

    const liveDuration = (
      startedAt: number,
      endedAt: number | null,
    ): string =>
      endedAt === null
        ? `${formatDuration(Date.now() - startedAt)}…`
        : formatDuration(record.durationMs ?? 0);

    if (record.kind === "user") {
      title.textContent = record.label || "(no text)";
      subtitle.textContent = "user prompt";
      cols.push(
        col(
          "Timing",
          Clock,
          row(
            "Time",
            formatClock(record.startedAt),
            new Date(record.startedAt).toLocaleString(),
          ),
          row("Marker", "point in time"),
        ),
      );
      raws.append(rawPane("Prompt", Pencil, record.promptRaw));
    } else if (record.kind === "tool") {
      title.textContent = record.name;
      subtitle.textContent = `tool execution${
        record.status ? ` · ${record.status}` : ""
      }`;
      cols.push(
        col(
          "Execution",
          Wrench,
          row(
            "Start",
            formatClock(record.startedAt),
            new Date(record.startedAt).toLocaleString(),
          ),
          row("Duration", liveDuration(record.startedAt, record.endedAt)),
          row("Status", record.status ?? "—"),
          row("ToolCall", record.toolCallId ?? "—"),
        ),
      );
      const left = document.createElement("div");
      left.className = "timeline-raw-col";
      left.append(rawPane("Arguments", Terminal, record.argsRaw));
      const right = document.createElement("div");
      right.className = "timeline-raw-col";
      right.append(rawPane("Result", ScrollText, record.resultRaw));
      raws.append(left, right);
    } else {
      title.textContent = record.model;
      const brand = matchModelBrand({ modelId: record.model });
      if (brand) {
        const icon = createBrandIcon(brand, 14);
        icon.classList.add("timeline-brand-icon");
        head.prepend(icon);
      }
      subtitle.textContent = `${record.purpose ?? "llm"}${
        record.iteration !== undefined ? ` · #${record.iteration}` : ""
      } · ${record.stream ? "stream" : "once"}`;
      cols.push(
        col(
          "Timing",
          Clock,
          row(
            "Start",
            formatClock(record.startedAt),
            new Date(record.startedAt).toLocaleString(),
          ),
          row("Duration", liveDuration(record.startedAt, record.endedAt)),
          row("Attempts", String(record.attempts)),
          row(
            "HTTP",
            record.httpStatus !== undefined ? String(record.httpStatus) : "—",
          ),
          row("Done", record.doneReason ?? "—"),
        ),
      );

      if (record.firstEventAt !== undefined) {
        const phaseRows = [
          row("Wait", formatDuration(record.firstEventAt - record.startedAt)),
        ];
        if (
          record.reasoningStartAt !== undefined &&
          record.reasoningEndAt !== undefined
        ) {
          phaseRows.push(
            row(
              "Reasoning",
              formatDuration(record.reasoningEndAt - record.reasoningStartAt),
            ),
          );
        }
        if (
          record.contentStartAt !== undefined &&
          record.contentEndAt !== undefined
        ) {
          phaseRows.push(
            row(
              "Content",
              formatDuration(record.contentEndAt - record.contentStartAt),
            ),
          );
        }
        cols.push(col("Phases", Hourglass, ...phaseRows));
      }

      const hasTokens =
        record.promptTokens !== undefined ||
        record.completionTokens !== undefined ||
        record.totalTokens !== undefined;
      if (hasTokens) {
        cols.push(
          col(
            "Tokens",
            Coins,
            row("Prompt", optionalNum(record.promptTokens)),
            row("Completion", optionalNum(record.completionTokens)),
            row("Cached", optionalNum(record.cachedTokens)),
            row("Cache write", optionalNum(record.cacheWriteTokens)),
            row("Total", optionalNum(record.totalTokens)),
          ),
        );
      }

      const tools = record.toolNames?.length
        ? `${record.toolCallCount} (${record.toolNames.join(", ")})`
        : record.toolCallCount !== undefined
          ? String(record.toolCallCount)
          : "—";
      cols.push(
        col(
          "Output",
          FileText,
          row("Text chars", optionalNum(record.textChars)),
          row("Reasoning chars", optionalNum(record.reasoningChars)),
          row("Tools", tools),
        ),
        col(
          "Request",
          Send,
          row("Messages", String(record.messageCount)),
          row("Tool defs", String(record.toolDefCount)),
        ),
      );

      const left = document.createElement("div");
      left.className = "timeline-raw-col";
      left.append(rawPane("Request payload", Braces, record.reqRaw));
      const right = document.createElement("div");
      right.className = "timeline-raw-col";
      // Reasoning + response merged into one pane, each section labelled.
      const streamSections: string[] = [];
      if (record.reasoningRaw !== undefined) {
        streamSections.push(
          `───── reasoning (${record.reasoningRaw.length.toLocaleString()} chars) ─────\n${record.reasoningRaw}`,
        );
      }
      if (record.textRaw !== undefined) {
        streamSections.push(
          `───── response (${record.textRaw.length.toLocaleString()} chars) ─────\n${record.textRaw}`,
        );
      }
      right.append(
        rawPane(
          "Stream",
          MessageSquare,
          streamSections.length > 0
            ? streamSections.join("\n\n")
            : undefined,
        ),
      );
      raws.append(left, right);
    }

    // Cards evenly fill one row — no trailing gap on the right.
    grid.style.gridTemplateColumns = `repeat(${cols.length}, minmax(0, 1fr))`;
    grid.append(...cols);

    this.detailEl.append(head);
    if (errEl) this.detailEl.append(errEl);
    this.detailEl.append(grid, raws);
    this.detailSignature = signature;
  }
}

function iconlessButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "timeline-zoom-btn";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.textContent = label;
  return button;
}

function barTitle(record: LlmTimelineRecord): string {
  if (record.kind === "user") {
    return `user · ${record.label || "(no text)"} · ${formatClock(record.startedAt)}`;
  }
  if (record.kind === "tool") {
    const duration =
      record.endedAt === null
        ? `${formatDuration(Date.now() - record.startedAt)}…`
        : formatDuration(record.durationMs ?? 0);
    return [
      `tool · ${record.name}`,
      duration,
      formatClock(record.startedAt),
      ...(record.status ? [record.status] : []),
      ...(record.error ? [record.error] : []),
    ].join(" · ");
  }
  const duration =
    record.endedAt === null
      ? `${formatDuration(Date.now() - record.startedAt)}…`
      : formatDuration(record.durationMs ?? 0);
  return [
    `${record.purpose ?? "llm"}${record.iteration !== undefined ? ` #${record.iteration}` : ""}`,
    record.model,
    duration,
    formatClock(record.startedAt),
    ...(record.attempts > 1 ? [`${record.attempts} attempts`] : []),
    ...(record.error ? [record.error] : []),
  ].join(" · ");
}

function section(label: string, icon?: IconNode): HTMLElement {
  const el = document.createElement("div");
  el.className = "timeline-detail-section";
  if (icon) el.append(createLucideIcon(icon, { size: 12 }));
  const text = document.createElement("span");
  text.textContent = label;
  el.append(text);
  return el;
}

/** Column: icon + heading + rows, laid side by side in the detail grid. */
function col(
  label: string,
  icon: IconNode,
  ...rows: HTMLElement[]
): HTMLElement {
  const el = document.createElement("div");
  el.className = "timeline-detail-col";
  el.append(section(label, icon), ...rows);
  return el;
}

function errorStrip(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "timeline-detail-error";
  el.append(createLucideIcon(TriangleAlert, { size: 12 }));
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);
  return el;
}

function row(label: string, value: string, title?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "timeline-detail-row";
  const labelEl = document.createElement("span");
  labelEl.className = "timeline-detail-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "timeline-detail-value";
  valueEl.textContent = value;
  if (title) valueEl.title = title;
  el.append(labelEl, valueEl);
  return el;
}

/** Always-visible raw payload pane (no collapse) with a copy button. */
function rawPane(
  title: string,
  icon: IconNode,
  text: string | undefined,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "timeline-raw-pane";
  const heading = document.createElement("div");
  heading.className = "timeline-raw-title";
  heading.append(createLucideIcon(icon, { size: 12 }));
  const label = document.createElement("span");
  label.textContent =
    text !== undefined
      ? `${title} · ${text.length.toLocaleString()} chars`
      : `${title} · no data`;
  heading.append(label);
  if (text !== undefined) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "timeline-raw-copy";
    copy.title = "Copy to clipboard";
    copy.setAttribute("aria-label", `Copy ${title}`);
    copy.append(createLucideIcon(Copy, { size: 12 }));
    copy.addEventListener("click", async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = copyTextFallback(text);
      }
      if (!ok) return;
      copy.replaceChildren(createLucideIcon(Check, { size: 12 }));
      copy.classList.add("is-copied");
      copy.title = "Copied";
      window.setTimeout(() => {
        copy.replaceChildren(createLucideIcon(Copy, { size: 12 }));
        copy.classList.remove("is-copied");
        copy.title = "Copy to clipboard";
      }, 1_200);
    });
    heading.append(copy);
  }
  const pre = document.createElement("pre");
  pre.textContent = text ?? "— raw payload stripped (aged out) or unavailable —";
  el.append(heading, pre);
  return el;
}

/** Legacy copy path when the async clipboard API is unavailable. */
function copyTextFallback(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function optionalNum(value: number | undefined): string {
  return value !== undefined ? String(value) : "—";
}
