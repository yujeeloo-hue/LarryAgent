
export const CAPTION_ROTATE_MS = 5000;
export const CAPTION_FADE_MS = 140;

export type CaptionSlot = {
  readonly lines: readonly string[];
  index: number;
  paused: boolean;
  textEl: HTMLElement;
  pipsEl: HTMLElement | null;
  cancelFade: (() => void) | null;
};

export type CaptionRotator = {
  add: (section: HTMLElement, lines: readonly string[]) => void;
  start: () => void;
  stop: () => void;
  tick: () => void;
  advance: (slot: CaptionSlot) => void;
  slots: () => readonly CaptionSlot[];
};

export type CaptionRotatorOptions = {
  defer?: (fn: () => void) => () => void;
  schedule?: (fn: () => void) => () => void;
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
