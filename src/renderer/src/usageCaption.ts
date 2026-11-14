/**
 * One rotating caption per provider section in the tray usage popup
 * (docs/plans/20261014-usage-popup-rotating-caption.md).
 *
 * Why: adapters return `lines: string[]` (reset times, absolute quotas,
 * balance breakdowns). Painting all of them stacked made the panel taller
 * than `USAGE_POPUP_MAX_HEIGHT`, so the bottom sections and the footer were
 * silently clipped. Bars always stay; the lines now share a single fixed
 * height slot and rotate in lockstep.
 *
 * Timing is single-sourced here — `CAPTION_ROTATE_MS` drives one shared
 * heartbeat for every slot (sections may hold a different number of lines,
 * each cycles independently), and `CAPTION_FADE_MS` is injected into CSS so
 * the fade and the swap can never drift apart.
 */

/** Dwell time per caption line, per user decision (2026-10-14). */
export const CAPTION_ROTATE_MS = 5000;
/** Cross-fade duration; also written to `--up-caption-fade` for the CSS side. */
export const CAPTION_FADE_MS = 140;

export type CaptionSlot = {
  readonly lines: readonly string[];
  index: number;
  /** Set while the pointer rests on this section — the shared tick skips it. */
  paused: boolean;
  textEl: HTMLElement;
  pipsEl: HTMLElement | null;
  /**
   * Pending fade write for THIS section. Must stay per-slot: one shared
   * handle made a tick's later section cancel the earlier section's pending
   * write, so only the last section ever changed (found by the production
   * build acceptance run, invisible to a synchronous `defer`).
   */
  cancelFade: (() => void) | null;
};

export type CaptionRotator = {
  /** Paint one fixed-height slot into `section`; no-op for zero lines. */
  add: (section: HTMLElement, lines: readonly string[]) => void;
  start: () => void;
  stop: () => void;
  /** Advance every non-paused slot by one line (the shared heartbeat). */
  tick: () => void;
  /** Manual one-step advance (click), used to read a specific line. */
  advance: (slot: CaptionSlot) => void;
  slots: () => readonly CaptionSlot[];
};

export type CaptionRotatorOptions = {
  /** Runs the DOM write after the fade-out. Production: setTimeout(140). */
  defer?: (fn: () => void) => () => void;
  /** Arms the heartbeat; returns its cancel handle. Production: setInterval. */
  schedule?: (fn: () => void) => () => void;
  /** With reduced motion the panel never moves on its own — click only. */
  prefersReducedMotion?: boolean;
};

const defaultDefer = (fn: () => void): (() => void) => {
  const timer = window.setTimeout(fn, CAPTION_FADE_MS);
  return () => window.clearTimeout(timer);
};

const defaultSchedule = (fn: () => void): (() => void) => {
  const timer = window.setInterval(fn, CAPTION_ROTATE_MS);
  return () => window.clearInterval(timer);
};

/** Publish the JS-owned durations as CSS custom properties (single source). */
export function applyCaptionTimingVars(): void {
  const root = document.documentElement;
  root.style.setProperty("--up-caption-fade", `${CAPTION_FADE_MS}ms`);
  root.style.setProperty("--up-caption-rotate", `${CAPTION_ROTATE_MS}ms`);
}

export function createCaptionRotator(
  options: CaptionRotatorOptions = {},
): CaptionRotator {
  const defer = options.defer ?? defaultDefer;
  const schedule = options.schedule ?? defaultSchedule;
  const reduced = options.prefersReducedMotion ?? false;

  const registered: CaptionSlot[] = [];
  let cancelHeartbeat: (() => void) | null = null;

  function paint(slot: CaptionSlot): void {
    slot.textEl.textContent = slot.lines[slot.index] ?? "";
    const pips = slot.pipsEl;
    if (pips) {
      const nodes = pips.children;
      for (let i = 0; i < nodes.length; i++) {
        nodes[i]!.classList.toggle("is-on", i === slot.index);
      }
    }
  }

  function step(slot: CaptionSlot, delta: number): void {
    const count = slot.lines.length;
    if (count < 2) return;
    const next = (slot.index + delta + count) % count;
    if (reduced) {
      slot.index = next;
      paint(slot);
      return;
    }
    slot.cancelFade?.();
    slot.textEl.classList.add("is-out");
    slot.cancelFade = defer(() => {
      slot.index = next;
      slot.textEl.classList.remove("is-out");
      paint(slot);
      slot.cancelFade = null;
    });
  }

  function arm(): void {
    cancelHeartbeat?.();
    cancelHeartbeat = null;
    // Reduced motion: no autonomous movement at all — the click path stays.
    if (reduced) return;
    cancelHeartbeat = schedule(() => rotator.tick());
  }

  const rotator: CaptionRotator = {
    add(section, lines) {
      if (!lines.length) return;
      const slotEl = document.createElement("div");
      slotEl.className = "up-caption";
      slotEl.dataset["count"] = String(lines.length);

      const textEl = document.createElement("div");
      textEl.className = "up-caption-text";
      textEl.textContent = lines[0] ?? "";
      // Escape hatch: the whole list stays reachable even though one line
      // is painted at a time.
      textEl.title = lines.join("\n");
      slotEl.append(textEl);

      let pipsEl: HTMLElement | null = null;
      if (lines.length > 1) {
        pipsEl = document.createElement("div");
        pipsEl.className = "up-pips";
        for (let i = 0; i < lines.length; i++) {
          const pip = document.createElement("span");
          pip.className = i === 0 ? "up-pip is-on" : "up-pip";
          pipsEl.append(pip);
        }
        slotEl.append(pipsEl);
      }

      const slot: CaptionSlot = {
        lines,
        index: 0,
        paused: false,
        textEl,
        pipsEl,
        cancelFade: null,
      };
      if (lines.length > 1) {
        slotEl.addEventListener("mouseenter", () => {
          slot.paused = true;
        });
        slotEl.addEventListener("mouseleave", () => {
          slot.paused = false;
        });
        slotEl.addEventListener("click", () => {
          step(slot, 1);
          // Re-anchor the heartbeat so a manual flip does not land in the
          // middle of the next automatic step.
          arm();
        });
      }
      section.append(slotEl);
      registered.push(slot);
    },

    start() {
      arm();
    },

    stop() {
      for (const slot of registered) {
        slot.cancelFade?.();
        slot.cancelFade = null;
      }
      cancelHeartbeat?.();
      cancelHeartbeat = null;
    },

    tick() {
      for (const slot of registered) {
        if (slot.paused) continue;
        step(slot, 1);
      }
    },

    advance(slot) {
      step(slot, 1);
      arm();
    },

    slots() {
      return registered;
    },
  };

  return rotator;
}
