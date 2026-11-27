export type StatusProgressPart = { key: string; text: string };

export const STATUS_CAROUSEL_DWELL_MS = 4000;

const DURATION_MS = 620;
const MAX_ANIMATED_GRAPHEMES = 80;
const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

type CarouselRun = {
  target: string;
  animations: Animation[];
  timer: ReturnType<typeof setTimeout> | undefined;
};

type Layout = { width: number; height: number; positions: number[] };

function graphemes(text: string): string[] {
  return segmenter
    ? Array.from(segmenter.segment(text), part => part.segment)
    : Array.from(text);
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function measure(host: HTMLElement, characters: readonly string[]): Layout {
  const probe = host.ownerDocument.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:0;top:0;";
  probe.setAttribute("aria-hidden", "true");
  const letters = characters.map(character => {
    const span = host.ownerDocument.createElement("span");
    span.textContent = character;
    probe.append(span);
    return span;
  });
  host.append(probe);
  const rect = probe.getBoundingClientRect();
  const positions = letters.map(letter => letter.getBoundingClientRect().left - rect.left);
  probe.remove();
  return { width: rect.width, height: rect.height, positions };
}

export class StatusCarousel {
  private items: readonly StatusProgressPart[] = [];
  private key = "";
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private run: CarouselRun | null = null;
  private hovered = false;
  private destroyed = false;
  private readonly onEnter = (): void => this.setHovered(true);
  private readonly onLeave = (): void => this.setHovered(false);

  constructor(
    private readonly host: HTMLElement,
    private readonly dwellMs: number = STATUS_CAROUSEL_DWELL_MS,
  ) {
    host.addEventListener("mouseenter", this.onEnter);
    host.addEventListener("mouseleave", this.onLeave);
  }

  setItems(items: readonly StatusProgressPart[]): void {
    if (this.destroyed) return;
    this.items = items;
    const nextKey = items.map(item => item.key).join("\u0000");
    if (nextKey !== this.key) {
      this.key = nextKey;
      this.index = 0;
      this.clearTimer();
      this.write(items[0]?.text ?? "", false);
      this.schedule();
      return;
    }
    if (this.run) return;
    this.write(items[this.index]?.text ?? "", false);
  }

  setHovered(hovered: boolean): void {
    if (this.destroyed || this.hovered === hovered) return;
    this.hovered = hovered;
    if (hovered) this.clearTimer();
    else this.schedule();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimer();
    this.cancelRun();
    this.host.removeEventListener("mouseenter", this.onEnter);
    this.host.removeEventListener("mouseleave", this.onLeave);
  }

  private schedule(): void {
    this.clearTimer();
    if (this.destroyed || this.hovered || this.items.length < 2) return;
    this.timer = setTimeout(() => this.advance(), this.dwellMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private advance(): void {
    this.timer = null;
    if (this.destroyed || this.items.length < 2) return;
    this.index = (this.index + 1) % this.items.length;
    this.write(this.items[this.index]?.text ?? "", true);
    this.schedule();
  }

  private cancelRun(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (run.timer !== undefined) clearTimeout(run.timer);
    for (const animation of run.animations) animation.cancel();
  }

  private settle(run: CarouselRun, text: string): void {
    if (this.run !== run) return;
    this.cancelRun();
    this.host.textContent = text;
    this.host.classList.remove("is-carousel-rolling");
    this.host.removeAttribute("aria-label");
    this.host.style.removeProperty("width");
    this.host.style.removeProperty("height");
  }

  private write(text: string, animate: boolean): void {
    const current = this.run?.target ?? this.host.textContent ?? "";
    if (current === text) return;
    this.cancelRun();
    const before = graphemes(current);
    const after = graphemes(text);
    if (
      !animate || !current || reducedMotion() ||
      typeof this.host.animate !== "function" ||
      typeof this.host.getBoundingClientRect !== "function" ||
      Math.max(before.length, after.length) > MAX_ANIMATED_GRAPHEMES
    ) {
      this.host.textContent = text;
      return;
    }
    const oldLayout = measure(this.host, before);
    const newLayout = measure(this.host, after);
    if (!oldLayout.width || !newLayout.width || !oldLayout.height) {
      this.host.textContent = text;
      return;
    }
    const run: CarouselRun = { target: text, animations: [], timer: undefined };
    this.run = run;
    this.host.textContent = "";
    this.host.classList.add("is-carousel-rolling");
    this.host.setAttribute("aria-label", text);
    this.host.style.width = `${oldLayout.width}px`;
    this.host.style.height = `${oldLayout.height}px`;
    const anchor = this.host.ownerDocument.createElement("span");
    anchor.className = "status-carousel-anchor";
    anchor.setAttribute("aria-hidden", "true");
    anchor.style.cssText = "visibility:hidden;white-space:pre;";
    anchor.textContent = "\u200b";
    this.host.append(anchor);
    const count = Math.max(before.length, after.length);
    const characterDuration = DURATION_MS * 0.66;
    for (let i = 0; i < count; i++) {
      const delay = count > 1 ? (i / (count - 1)) * DURATION_MS * 0.34 : 0;
      if (before[i]) {
        const outgoing = this.host.ownerDocument.createElement("span");
        outgoing.className = "status-carousel-glyph status-carousel-previous";
        outgoing.setAttribute("data-glyph", before[i] ?? "");
        outgoing.setAttribute("aria-hidden", "true");
        outgoing.style.left = `${oldLayout.positions[i]}px`;
        this.host.append(outgoing);
        run.animations.push(outgoing.animate([
          { transform: "translateY(0)", opacity: 1, filter: "blur(0px)" },
          { transform: "translateY(-13px)", opacity: 0, filter: "blur(1px)" },
        ], { duration: characterDuration, delay, easing: "cubic-bezier(.3,0,.3,1)", fill: "both" }));
      }
      if (after[i]) {
        const incoming = this.host.ownerDocument.createElement("span");
        incoming.className = "status-carousel-glyph";
        incoming.setAttribute("aria-hidden", "true");
        incoming.textContent = after[i] ?? "";
        incoming.style.left = `${newLayout.positions[i]}px`;
        this.host.append(incoming);
        run.animations.push(incoming.animate([
          { transform: "translateY(13px)", opacity: 0, filter: "blur(1px)" },
          { transform: "translateY(0)", opacity: 1, filter: "blur(0px)" },
        ], { duration: characterDuration, delay, easing: "cubic-bezier(.22,.8,.25,1)", fill: "both" }));
      }
    }
    run.animations.push(this.host.animate([
      { width: `${oldLayout.width}px` }, { width: `${newLayout.width}px` },
    ], { duration: DURATION_MS, easing: "cubic-bezier(.22,.8,.25,1)", fill: "both" }));
    run.timer = setTimeout(() => this.settle(run, text), DURATION_MS + 80);
    void Promise.allSettled(run.animations.map(animation => animation.finished))
      .then(() => this.settle(run, text));
  }
}
