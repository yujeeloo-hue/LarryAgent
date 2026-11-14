/** Thinking title's staggered roll. Mirrored in relay/web/src/reasoningTitle.ts. */
const DURATION_MS = 620;
const MAX_ANIMATED_GRAPHEMES = 80;
const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

type TitleTransition = {
  text: string;
  animations: Animation[];
  timer: ReturnType<typeof setTimeout> | undefined;
  media: MediaQueryList | undefined;
  onReducedMotion: () => void;
};
const transitions = new WeakMap<HTMLElement, TitleTransition>();

function finish(title: HTMLElement, run: TitleTransition): void {
  // Cancelled animations can finish after a newer status has arrived.
  if (transitions.get(title) !== run) return;
  transitions.delete(title);
  clearTimeout(run.timer);
  run.media?.removeEventListener?.("change", run.onReducedMotion);
  for (const animation of run.animations) animation.cancel();
  title.textContent = run.text;
  title.classList.remove("is-title-transitioning");
  title.removeAttribute("role");
  title.removeAttribute("aria-label");
  title.style.removeProperty("width");
  title.style.removeProperty("height");
}

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text);
}

/** Measure all positions in one layout, including spaces and non-Latin glyphs. */
function measure(title: HTMLElement, characters: readonly string[]) {
  const probe = title.ownerDocument.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:0;top:0;";
  probe.setAttribute("aria-hidden", "true");
  const letters = characters.map(character => {
    const span = title.ownerDocument.createElement("span");
    span.textContent = character;
    probe.append(span);
    return span;
  });
  title.append(probe);
  const rect = probe.getBoundingClientRect();
  const positions = letters.map(letter => letter.getBoundingClientRect().left - rect.left);
  probe.remove();
  return { width: rect.width, height: rect.height, positions };
}

/** Repeated token/duration ticks leave an in-flight title transition untouched. */
export function setReasoningTitle(title: HTMLElement, text: string): void {
  if (title.textContent === text) return;
  const pending = transitions.get(title);
  if (pending) finish(title, pending);
  const previous = title.textContent ?? "";
  const media = typeof window !== "undefined"
    ? window.matchMedia?.("(prefers-reduced-motion: reduce)")
    : undefined;
  const before = graphemes(previous);
  const after = graphemes(text);
  if (!previous || !text || !title.isConnected || media?.matches ||
      typeof title.animate !== "function" ||
      Math.max(before.length, after.length) > MAX_ANIMATED_GRAPHEMES) {
    title.textContent = text;
    return;
  }
  const oldLayout = measure(title, before);
  const newLayout = measure(title, after);
  // Hidden transcript slices (and DOM-only runtimes) have no usable geometry.
  if (!oldLayout.width || !newLayout.width || !oldLayout.height) {
    title.textContent = text;
    return;
  }
  const run: TitleTransition = {
    text, animations: [], timer: undefined, media,
    onReducedMotion: () => { if (media?.matches) finish(title, run); },
  };
  transitions.set(title, run);
  title.textContent = "";
  title.classList.add("is-title-transitioning");
  // In-flow baseline anchor: an inline-block whose only children are
  // absolutely-positioned glyphs aligns its baseline to the box's BOTTOM
  // edge — inline-flow hosts (CoCo check rows) shifted ±2–3px on every
  // status change while the roll ran. The anchor's ::before ZWSP (surface
  // CSS, generated so it stays out of textContent) re-creates a real line
  // box and keeps the text baseline still under the rolling glyphs.
  const anchor = title.ownerDocument.createElement("span");
  anchor.className = "reasoning-title-anchor";
  anchor.setAttribute("aria-hidden", "true");
  anchor.style.cssText = "visibility:hidden;white-space:pre;";
  title.append(anchor);
  // Expose the whole status once, rather than spelling out positioned glyphs.
  title.setAttribute("role", "group");
  title.setAttribute("aria-label", text);
  title.style.width = `${oldLayout.width}px`;
  title.style.height = `${oldLayout.height}px`;
  const count = Math.max(before.length, after.length);
  const characterDuration = DURATION_MS * 0.66;
  for (let i = 0; i < count; i++) {
    const delay = count > 1 ? (i / (count - 1)) * DURATION_MS * 0.34 : 0;
    if (before[i]) {
      const outgoing = title.ownerDocument.createElement("span");
      outgoing.className = "reasoning-title-glyph reasoning-title-previous";
      // Generated content keeps textContent equal to the latest title and
      // aria-hidden excludes the departing letters from the button's name.
      outgoing.dataset.glyph = before[i];
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.style.left = `${oldLayout.positions[i]}px`;
      title.append(outgoing);
      run.animations.push(outgoing.animate([
        { transform: "translateY(0)", opacity: 1, filter: "blur(0px)" },
        { transform: "translateY(-13px)", opacity: 0, filter: "blur(1px)" },
      ], { duration: characterDuration, delay, easing: "cubic-bezier(.3,0,.3,1)", fill: "both" }));
    }
    if (after[i]) {
      const incoming = title.ownerDocument.createElement("span");
      incoming.className = "reasoning-title-glyph";
      incoming.setAttribute("aria-hidden", "true");
      incoming.textContent = after[i] ?? "";
      incoming.style.left = `${newLayout.positions[i]}px`;
      title.append(incoming);
      run.animations.push(incoming.animate([
        { transform: "translateY(13px)", opacity: 0, filter: "blur(1px)" },
        { transform: "translateY(0)", opacity: 1, filter: "blur(0px)" },
      ], { duration: characterDuration, delay, easing: "cubic-bezier(.22,.8,.25,1)", fill: "both" }));
    }
  }
  run.animations.push(title.animate([
    { width: `${oldLayout.width}px` }, { width: `${newLayout.width}px` },
  ], { duration: DURATION_MS, easing: "cubic-bezier(.22,.8,.25,1)", fill: "both" }));
  media?.addEventListener?.("change", run.onReducedMotion);
  void Promise.allSettled(run.animations.map(animation => animation.finished))
    .then(() => finish(title, run));
  // Also release glyphs if a removed/hidden document stops its animation timeline.
  run.timer = setTimeout(() => finish(title, run), DURATION_MS + 100);
}
