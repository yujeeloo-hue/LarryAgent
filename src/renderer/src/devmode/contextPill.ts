/**
 * Dev Mode top context pill — a floating strip over the chat pane
 * (below its header), echoing what the agent is working from.
 *
 * Content shapes (from the approved scripts/overlay-demo.html mock):
 *  - prompt: the latest user prompt (single-line ellipsis)
 *  - task:   while a turn is running — current step text (full width; the
 *    plan title lives in the tooltip), step dots + mono timer
 *  - notice: transient command feedback (the old composer slash-hint bar),
 *    shown via showNotice() — one status line, no fold affordance, timer
 *    restores the snapshot-driven mode (see NOTICE_DEFAULT_MS).
 *
 * Mode selection is a pure function over a snapshot the
 * ConversationController emits; the controller here only renders, folds
 * (auto: the conversation reports whether the prompt bubble is on screen)
 * and ticks the elapsed timer locally.
 */

export type ContextPillStepState = "done" | "current" | "todo";

/** Data the conversation layer emits (normalized — no session types leak). */
export type ContextPillSnapshot = {
  running: boolean;
  /** Latest user prompt text (whitespace-collapsed); null = none yet. */
  lastUserText: string | null;
  /**
   * File names attached to the prompt backing `lastUserText` (null = no
   * attachments). Drives the badge: count chip beside the text, or the
   * whole echo when the prompt is files-only.
   */
  lastUserFiles: string[] | null;
  /** Live turn progress text (e.g. "Waiting for model…" / tool line). */
  progressText: string;
  /**
   * Whether the latest user prompt bubble is on screen in the conversation
   * list. Drives auto-fold: visible → fold the pill to the 3-dot strip
   * (the echo is redundant); off-screen → expand it again. Edge-triggered:
   * transitions also clear a manual peek (click on the folded strip).
   */
  promptVisible: boolean;
  /** Active plan, if one exists while the snapshot was taken. */
  plan: {
    title: string;
    steps: Array<{ title: string; state: ContextPillStepState }>;
  } | null;
};

export type ContextPillMode =
  | { kind: "hidden" }
  | { kind: "prompt"; text: string; files: string[] | null }
  | { kind: "status"; text: string }
  | {
      kind: "task";
      title: string;
      stepTitle: string | null;
      steps: ContextPillStepState[];
      /** Completed step count (the "2/5" meta was retired — dots carry it). */
      done: number;
    };

/** Map a session PlanStepStatus onto the pill's three dot states. */
export function pillStepState(status: string): ContextPillStepState {
  if (status === "completed") return "done";
  if (status === "in_progress") return "current";
  return "todo"; // pending / cancelled / unknown
}

/** Content = latest user prompt OR the active plan — nothing else.
 *  Running + plan → task card (title + current step + dots + timer);
 *  otherwise → the latest prompt (spinner while a turn runs). */
export function computeContextPillMode(
  snapshot: ContextPillSnapshot,
): ContextPillMode {
  if (snapshot.running) {
    const steps = snapshot.plan?.steps ?? [];
    if (snapshot.plan && steps.length > 0) {
      const currentIdx = steps.findIndex((s) => s.state === "current");
      const focusIdx = currentIdx >= 0 ? currentIdx : steps.length - 1;
      return {
        kind: "task",
        title: snapshot.plan.title,
        stepTitle: steps[focusIdx]?.title ?? null,
        steps: steps.map((s) => s.state),
        done: steps.filter((s) => s.state === "done").length,
      };
    }
  }
  const text = snapshot.lastUserText?.trim() ?? "";
  const files =
    snapshot.lastUserFiles && snapshot.lastUserFiles.length > 0
      ? snapshot.lastUserFiles
      : null;
  if (text || files) return { kind: "prompt", text, files };
  return { kind: "hidden" };
}

/**
 * Editor-pill mode: a status strip — spinner + live progress text while a
 * turn runs (the chat pane is collapsed there, so the prompt lives on the
 * chat pill instead). Hidden when idle.
 */
export function computeEditorStatusMode(
  snapshot: ContextPillSnapshot,
): ContextPillMode {
  if (!snapshot.running) return { kind: "hidden" };
  const text = snapshot.progressText.trim();
  if (!text) return { kind: "hidden" };
  return { kind: "status", text };
}

/** Structural equality so the emitter can skip no-op callbacks. */
export function sameContextPillSnapshot(
  a: ContextPillSnapshot | null,
  b: ContextPillSnapshot,
): boolean {
  if (!a) return false;
  if (
    a.running !== b.running ||
    a.lastUserText !== b.lastUserText ||
    !sameFileList(a.lastUserFiles, b.lastUserFiles) ||
    a.progressText !== b.progressText ||
    a.promptVisible !== b.promptVisible
  ) {
    return false;
  }
  const ap = a.plan;
  const bp = b.plan;
  if (!ap || !bp) return !ap === !bp;
  if (ap.title !== bp.title || ap.steps.length !== bp.steps.length) {
    return false;
  }
  return ap.steps.every(
    (s, i) =>
      s.title === bp.steps[i]?.title && s.state === bp.steps[i]?.state,
  );
}

function sameFileList(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b) return !a === !b;
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/** Collapse the text parts of a user message into one prompt line. */
export function pillTextFromParts(
  parts: Array<Record<string, unknown>>,
): string | null {
  const text = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => String(p.text))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/**
 * Attachment display names from a user message — the badge's tooltip
 * listing. Falls back to the URI basename when the part carries no name.
 */
export function pillFilesFromParts(
  parts: Array<Record<string, unknown>>,
): string[] | null {
  const names: string[] = [];
  for (const part of parts) {
    if (part?.type !== "attachment") continue;
    const name =
      typeof part.name === "string" && part.name.trim()
        ? part.name.trim()
        : typeof part.uri === "string"
          ? (part.uri.split("?")[0]!.split("/").pop() ?? "")
          : "";
    if (name) names.push(name);
  }
  return names.length > 0 ? names : null;
}

/** Folded-state affordance: three solid CSS dots — no icons, no button. */
const FOLD_DOT_COUNT = 3;

/** Editor status strip: success label + dwell before the leave fade. */
const DONE_FADE_LABEL = "Done";
const DONE_FADE_DWELL_MS = 3000;
const DONE_FADE_ANIMATION = "devmode-ctxpill-leave";

/** Notice (command feedback) default dwell — mirrors the old composer
 * slash-hint bar's auto-fade. */
const NOTICE_DEFAULT_MS = 3200;

/**
 * Per-character rise delay for the text morph — 14ms base, scaled down so
 * the WHOLE line commits within a ~160ms budget. The uncapped i×14ms made
 * a 120-char progress line take 1.7s before its tail even started to fade
 * in — with frequent progress swaps the tail never showed at all (the
 * "content not fully shown" report). Exported for unit tests.
 */
export const MORPH_STAGGER_BUDGET_MS = 160;
export function morphStaggerStep(charCount: number): number {
  if (charCount <= 1) return 14;
  return Math.min(14, MORPH_STAGGER_BUDGET_MS / (charCount - 1));
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

const CHEVRON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';



const PAPERCLIP_SVG =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg>';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type PillElements = {
  root: HTMLElement;
  spin: HTMLElement;
  /** Success badge — shown instead of the spinner while done-dwelling. */
  check: HTMLElement;
  dots: HTMLElement;
  text: HTMLElement;
  /** File-reference badge (count chip / files-only echo). */
  files: HTMLElement;
  steps: HTMLElement;
  meta: HTMLElement;
  fold: HTMLButtonElement | null;
};

/** getComputedStyle length → px number ("normal"/"" → 0). */
function toPx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export class ContextPillController {
  private els: PillElements | null = null;
  private mode: ContextPillMode = { kind: "hidden" };
  private folded = false;
  /** Last reported prompt visibility (null = nothing reported yet). */
  private promptVisible: boolean | null = null;
  /**
   * Manual fold-state override (null = auto): true = folded via the
   * chevron, false = expanded via the dots strip. Any prompt-visibility
   * transition clears it and re-syncs to auto.
   */
  private manualFolded: boolean | null = null;
  /** External visibility gate (editor pill: only when chat is collapsed). */
  private gate = true;
  private runningSince: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** doneFade state: dwelling on "Done" (or waiting out the leave anim). */
  private doneActive = false;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Notice state (command feedback — the old composer slash-hint bar):
   * transiently owns the strip, then the pill restores to whatever the
   * latest snapshot computes. Null = no notice in flight.
   */
  private notice: { text: string; spinner: boolean } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fold state captured when the notice arrived (restored on expiry). */
  private foldedBeforeNotice = false;
  /** Latest snapshot — the notice expiry recomputes the mode from it. */
  private lastSnapshot: ContextPillSnapshot | null = null;

  constructor(
    private readonly options?: {
      /** Mode computer — chat pill (prompt/plan) vs editor status strip. */
      computeMode?: (snapshot: ContextPillSnapshot) => ContextPillMode;
      /**
       * Whether the pill folds at all. The chat pill auto-folds while the
       * prompt is on screen; the editor status strip is transient progress
       * — never folds.
       */
      foldable?: boolean;
      /**
       * Editor status strip only: when the turn ends, show a green-check
       * "Done" state for 3s, then leave via a scale+fade animation instead
       * of snapping away. A new turn, reset, or gate-off cancels it.
       */
      doneFade?: boolean;
    },
  ) {}

  mount(parent: HTMLElement): void {
    if (this.els) return;
    const root = document.createElement("div");
    root.className = this.options?.foldable === false
      ? "devmode-ctxpill no-fold"
      : "devmode-ctxpill";
    root.hidden = true;

    const spin = document.createElement("span");
    spin.className = "ctxpill-spin";
    spin.setAttribute("aria-hidden", "true");

    // Success badge (doneFade): green disc + white check, shown instead of
    // the spinner while the strip dwells on "Done" after the turn ends.
    const check = document.createElement("span");
    check.className = "ctxpill-check";
    check.setAttribute("aria-hidden", "true");
    check.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

    const dots = document.createElement("span");
    dots.className = "ctxpill-dots";
    dots.setAttribute("aria-hidden", "true");
    for (let i = 0; i < FOLD_DOT_COUNT; i += 1) {
      dots.append(document.createElement("i"));
    }

    const text = document.createElement("span");
    text.className = "ctxpill-text";

    const files = document.createElement("span");
    files.className = "ctxpill-files";
    files.hidden = true;

    const steps = document.createElement("span");
    steps.className = "ctxpill-steps";
    steps.setAttribute("aria-hidden", "true");

    const meta = document.createElement("span");
    meta.className = "ctxpill-meta";

    // Manual fold chevron — EXPANDED state only (CSS hides it folded,
    // where the whole strip is the expand click target).
    let fold: HTMLButtonElement | null = null;
    if (this.options?.foldable !== false) {
      fold = document.createElement("button");
      fold.type = "button";
      fold.className = "ctxpill-fold";
      fold.setAttribute("aria-label", "Collapse context bar");
      fold.innerHTML = CHEVRON_SVG;
      fold.addEventListener("click", () => {
        if (this.folded) return;
        this.manualFolded = true;
        this.setFolded(true);
      });
    }

    root.append(spin, check, dots, text, files, steps, meta);
    if (fold) root.append(fold);
    // Leave-fade completion: the CSS animation is the clock; animationend
    // swaps the pill to hidden. (Reduced-motion path skips the class.)
    root.addEventListener("animationend", (event) => {
      const name = (event as AnimationEvent).animationName;
      if (name !== DONE_FADE_ANIMATION || !this.doneActive) return;
      this.doneActive = false;
      // Strip the class: a leftover `animation … forwards` re-plays when
      // display flips back (hidden → shown), pinning opacity at 0 and
      // making the NEXT turn's strip invisible.
      root.classList.remove("is-leaving");
      this.mode = { kind: "hidden" };
      this.render();
    });
    // The folded strip is one big click target — clicking (or Enter/Space,
    // it carries role=button while folded) expands it until the prompt
    // visibility next changes.
    root.addEventListener("click", (event) => {
      // The chevron owns its clicks (fold) — never treat them as strip taps.
      if (this.els?.fold?.contains(event.target as Node)) return;
      if (this.options?.foldable === false || !this.folded) return;
      this.manualFolded = false;
      this.setFolded(false);
    });
    root.addEventListener("keydown", (event) => {
      if (this.options?.foldable === false || !this.folded) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.manualFolded = false;
      this.setFolded(false);
    });
    parent.append(root);
    this.els = { root, spin, check, dots, text, files, steps, meta, fold };
    this.render();
  }

  destroy(): void {
    this.stopTimer();
    this.cancelNotice();
    this.els?.root.remove();
    this.els = null;
  }

  private setFolded(folded: boolean): void {
    if (this.options?.foldable === false) return;
    if (this.folded === folded) return;
    this.folded = folded;
    this.render();
  }

  /** External visibility gate — false hides even with content. */
  setGate(visible: boolean): void {
    if (this.gate === visible) return;
    this.gate = visible;
    // Gate-off yanks the strip (chat pane expanded) — never linger on Done.
    if (!visible) this.cancelDoneFade();
    this.render();
  }

  /** Clear everything (session switched / no session). */
  reset(): void {
    this.cancelNotice();
    this.cancelDoneFade();
    this.lastSnapshot = null;
    this.mode = { kind: "hidden" };
    this.runningSince = null;
    this.render();
  }

  /**
   * Command feedback notice (replaces the old composer slash-hint bar):
   * temporarily owns the strip with a one-line status — no fold affordance
   * (CSS hides the chevron), forced expanded while active. `durationMs`
   * later the pill restores to whatever the latest snapshot computes
   * (prompt echo / task card / hidden). `spinner` marks in-flight work
   * ("Optimising prompt…"); the editor status strip mirrors notices so
   * feedback survives a collapsed chat pane.
   */
  showNotice(text: string, durationMs = NOTICE_DEFAULT_MS, options?: {
    spinner?: boolean;
  }): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.cancelNotice();
    this.cancelDoneFade();
    this.foldedBeforeNotice = this.folded;
    this.notice = { text: trimmed, spinner: options?.spinner === true };
    // A folded strip shows only dots — the notice must be readable, so
    // expand for its lifetime (the chevron is hidden anyway).
    this.setFolded(false);
    this.noticeTimer = setTimeout(
      () => this.endNotice(),
      Math.max(600, durationMs),
    );
    this.render();
  }

  /** Notice expiry: recompute the mode from the latest snapshot. */
  private endNotice(): void {
    this.noticeTimer = null;
    if (!this.notice) return;
    this.notice = null;
    const snapshot = this.lastSnapshot;
    if (snapshot) {
      // Running transitions were swallowed while the notice owned the
      // strip — re-derive the timer baseline alongside the mode.
      const wasRunning = this.runningSince != null;
      this.mode =
        this.options?.computeMode?.(snapshot) ??
        computeContextPillMode(snapshot);
      if (snapshot.running) {
        if (this.runningSince == null) this.runningSince = Date.now();
        this.cancelDoneFade();
      } else {
        this.runningSince = null;
        if (
          this.options?.doneFade &&
          wasRunning &&
          this.mode.kind === "hidden"
        ) {
          this.enterDoneFade();
        }
      }
    } else {
      this.mode = { kind: "hidden" };
    }
    // A prompt-visibility transition swallowed by the notice replays here
    // (edge semantics + manual-override clearing, same as the live path);
    // otherwise restore the fold state captured on notice entry.
    const visibleNow = this.lastSnapshot?.promptVisible ?? null;
    if (
      snapshot &&
      this.options?.foldable !== false &&
      visibleNow !== null &&
      visibleNow !== this.promptVisible
    ) {
      this.applyPromptVisible(visibleNow);
    } else {
      this.setFolded(this.foldedBeforeNotice);
    }
    this.render();
  }

  /** Abort the notice — a new notice, reset, or destroy restarts clean. */
  private cancelNotice(): void {
    if (this.noticeTimer != null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.notice = null;
  }

  update(snapshot: ContextPillSnapshot): void {
    this.lastSnapshot = snapshot;
    // The notice owns the strip: swallow mode/running changes (the expiry
    // recomputes from this snapshot). Visibility rides setGate/render.
    if (this.notice) return;
    // Done dwell owns the strip: idle frames after the turn's final
    // running=false (progressText clears, promptVisible flips, …) would
    // recompute mode=hidden and yank the dwelling "Done" away — and a
    // display:none strip never fires animationend, dead-locking the
    // leave fade. Swallow them; a running frame cancels the dwell below.
    if (this.doneActive && !snapshot.running) return;
    const wasRunning = this.runningSince != null;
    const prevMode = this.mode;
    this.mode =
      this.options?.computeMode?.(snapshot) ?? computeContextPillMode(snapshot);
    this.applyPromptVisible(snapshot.promptVisible);
    if (snapshot.running) {
      if (this.runningSince == null) this.runningSince = Date.now();
      this.cancelDoneFade();
    } else {
      this.runningSince = null;
      // Editor status strip: a running→idle transition dwells on a
      // success state before hiding (user-approved variant B).
      if (
        this.options?.doneFade &&
        wasRunning &&
        prevMode.kind === "status" &&
        this.mode.kind === "hidden"
      ) {
        this.enterDoneFade();
      }
    }
    this.render();
  }

  /** Success dwell: green check + "Done" for 3s, then the leave fade. */
  private enterDoneFade(): void {
    this.cancelDoneFade();
    this.doneActive = true;
    this.mode = { kind: "status", text: DONE_FADE_LABEL };
    this.doneTimer = setTimeout(() => this.startLeaveFade(), DONE_FADE_DWELL_MS);
  }

  private startLeaveFade(): void {
    this.doneTimer = null;
    if (!this.doneActive || !this.els) return;
    // Reduced motion: no animation (and thus no animationend) — hide now.
    if (prefersReducedMotion()) {
      this.doneActive = false;
      this.mode = { kind: "hidden" };
      this.render();
      return;
    }
    this.els.root.classList.add("is-leaving");
  }

  /** Abort the dwell/leave — a new turn, reset, or gate-off restarts clean. */
  private cancelDoneFade(): void {
    if (this.doneTimer != null) {
      clearTimeout(this.doneTimer);
      this.doneTimer = null;
    }
    if (!this.doneActive) return;
    this.doneActive = false;
    this.els?.root.classList.remove("is-leaving");
  }

  /**
   * Auto-fold, edge-triggered: only prompt-visibility TRANSITIONS move the
   * pill (visible → fold to the dots strip, off-screen → expand), and every
   * transition clears the manual override (chevron fold / dots-strip
   * expand) — so a manual state persists while you keep reading, and the
   * next visibility change re-syncs to auto.
   */
  private applyPromptVisible(visible: boolean): void {
    if (this.options?.foldable === false) return;
    if (this.promptVisible === visible) return;
    this.promptVisible = visible;
    this.manualFolded = null;
    this.setFolded(visible);
  }

  private render(): void {
    const els = this.els;
    if (!els) return;
    if (this.notice) {
      this.renderNotice();
      return;
    }
    const mode = this.mode;
    const visible = mode.kind !== "hidden" && this.gate;

    els.root.hidden = !visible;
    els.root.classList.remove("is-notice");
    els.root.classList.toggle("is-task", mode.kind === "task");
    els.root.classList.toggle("is-prompt", mode.kind === "prompt");
    els.root.classList.toggle("is-status", mode.kind === "status");
    els.root.classList.toggle("is-folded", this.folded);
    // Spinner rides either shape while a turn is running.
    els.root.classList.toggle("is-running", this.runningSince != null);
    // DoneFade: green check replaces the spinner while dwelling on "Done".
    els.root.classList.toggle("is-done", this.doneActive);

    if (!visible) {
      this.stopTimer();
      this.syncFoldA11y();
      return;
    }

    if (mode.kind === "prompt" || mode.kind === "status") {
      this.renderPillText(mode.text);
      els.root.title = mode.text;
      this.renderFilesBadge(mode.kind === "prompt" ? mode.files : null);
    } else if (mode.kind === "task") {
      const focus = `${mode.title}${mode.stepTitle ? ` — ${mode.stepTitle}` : ""}`;
      // Space goes to the step description (demo'd v2 shape): the plan
      // title lives in the tooltip + the floating plan card. Drop the
      // morph marker so a later prompt with the SAME text still counts.
      delete els.text.dataset.morphText;
      els.text.classList.remove("is-morph-in");
      els.text.textContent = mode.stepTitle ?? mode.title;
      els.root.title = focus;
      this.renderFilesBadge(null);
    }

    // Folded strip shows only dots — the native tooltip carries the prompt
    // the viewport is anchored to (visible prompt if one is on screen, else
    // the nearest prompt above it — the same rule as the expanded echo),
    // even while a running task card owns the visible content. Files-only
    // prompts (no text) fall back to the attachment names.
    if (this.folded) {
      const snap = this.lastSnapshot;
      const promptText = snap?.lastUserText?.trim() ?? "";
      const files = snap?.lastUserFiles ?? null;
      const tooltip = promptText || (files && files.length > 0 ? files.join("\n") : "");
      if (tooltip) els.root.title = tooltip;
    }

    // Step dots (task + expanded only).
    els.steps.replaceChildren(
      ...(mode.kind === "task" ? mode.steps : []).map((state) => {
        const dot = document.createElement("i");
        if (state === "done") dot.className = "done";
        else if (state === "current") dot.className = "cur";
        return dot;
      }),
    );

    this.renderMeta();
    this.syncTimer();
    this.syncWidth();
    this.syncFoldA11y();
  }

  /**
   * Notice rendering: one line of command feedback — spinner only when the
   * notice itself is in-flight (a running turn keeps its own), never folded
   * (the chevron is hidden by CSS while .is-notice), no files/steps/meta.
   */
  private renderNotice(): void {
    const els = this.els!;
    const notice = this.notice!;
    els.root.hidden = !this.gate;
    els.root.classList.toggle("is-notice", true);
    els.root.classList.toggle("is-task", false);
    els.root.classList.toggle("is-prompt", false);
    els.root.classList.toggle("is-status", true);
    els.root.classList.toggle("is-folded", false);
    els.root.classList.toggle("is-running", notice.spinner);
    els.root.classList.toggle("is-done", false);
    this.renderPillText(notice.text);
    els.root.title = notice.text;
    this.renderFilesBadge(null);
    els.steps.replaceChildren();
    els.meta.textContent = "";
    this.stopTimer();
    this.syncWidth();
    this.syncFoldA11y();
  }

  /** Folded strip is clickable → expose it as a button to the a11y tree. */
  private syncFoldA11y(): void {    const root = this.els?.root;
    if (!root) return;
    if (this.folded && this.options?.foldable !== false) {
      root.setAttribute("role", "button");
      root.setAttribute("aria-label", "Expand context bar");
      root.setAttribute("tabindex", "0");
    } else {
      root.removeAttribute("role");
      root.removeAttribute("aria-label");
      root.removeAttribute("tabindex");
    }
  }

  /**
   * File-reference badge (option A): beside prompt text → paperclip + count,
   * tooltip lists every name; files-only prompt → the badge widens into the
   * echo itself ("N files"). Any other shape hides it.
   */
  private renderFilesBadge(files: string[] | null): void {
    const els = this.els;
    if (!els) return;
    if (!files || files.length === 0) {
      els.files.hidden = true;
      els.files.removeAttribute("title");
      return;
    }
    els.files.hidden = false;
    els.files.classList.toggle("is-solo", this.mode.kind === "prompt" && !this.mode.text);
    els.files.title = files.join("\n");
    els.files.replaceChildren();
    els.files.insertAdjacentHTML("afterbegin", PAPERCLIP_SVG);
    const label = document.createElement("span");
    label.textContent =
      this.mode.kind === "prompt" && !this.mode.text
        ? `${files.length} ${files.length === 1 ? "file" : "files"}`
        : String(files.length);
    els.files.append(label);
  }

  /**
   * Status/prompt text with the per-letter rise (approved variant A): the
   * NEW text's characters fade in with a staggered delay, masking the width
   * snap on the status strip. The step is scaled by line length so the
   * whole line commits within MORPH_STAGGER_BUDGET_MS — the fixed 14ms
   * left long progress lines' tails invisible for over a second. Falls
   * back to plain text without a layout engine (tests) or under
   * prefers-reduced-motion; identical text (a fold/gate re-render) is a
   * no-op. Task mode keeps its composite render.
   */
  private renderPillText(text: string): void {
    const els = this.els;
    if (!els) return;
    if (els.text.dataset.morphText === text) return;
    els.text.dataset.morphText = text;
    if (
      typeof window.requestAnimationFrame !== "function" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      els.text.replaceChildren(document.createTextNode(text));
      return;
    }
    els.text.classList.remove("is-morph-in");
    const chars = [...text];
    const step = morphStaggerStep(chars.length);
    els.text.replaceChildren(
      ...chars.map((ch, i) => {
        const span = document.createElement("span");
        span.className =
          ch === " " ? "ctxpill-char ctxpill-char-space" : "ctxpill-char";
        span.textContent = ch;
        span.style.transitionDelay = `${(i * step).toFixed(1)}ms`;
        return span;
      }),
    );
    // Commit the pre-rise state (opacity 0 / +5px) synchronously, then
    // flip the class — the staggered transitions start from a known base
    // without waiting for a frame (same reflow trick as syncWidth).
    void els.text.offsetWidth;
    els.text.classList.add("is-morph-in");
  }

  /**
   * Width tween on content changes: measure the natural (content) width
   * (see measureNaturalWidth — container-independent) and commit it; CSS
   * animates from the CURRENT computed width to the new one. Crucially
   * there is no "restore old width + reflow" here: that reset restarted
   * the tween on every text swap, so a busy tool chain kept the box
   * perpetually behind the text (the "Writing file…" truncation). Plain
   * retargeting continues from wherever the tween is. Skipped without a
   * layout engine (linkedom: widths 0 → stay auto).
   */
  private syncWidth(): void {
    const root = this.els?.root;
    if (!root || root.hidden) return;
    const next = this.measureNaturalWidth();
    if (!next) return;
    root.style.width = `${next}px`;
  }

  /**
   * Natural (content-driven) width — border + padding + gaps + every
   * visible child at its own natural size. Deliberately never reads the
   * pill's own layout width: renders landing while the chat pane is
   * mid-collapse (flex-basis tweening to 0) must not bake a transitional
   * width into an explicit px, and the abspos left:50% shrink-to-fit cap
   * (~half the pane) must not limit the pill. Container clamping stays
   * with the CSS percentage max-width, which re-applies at layout time
   * as the pane animates — collapse shrinks the pill live, expanding
   * restores it, no re-measure needed. Returns 0 without a layout engine
   * (linkedom tests) — callers keep width:auto then.
   */
  private measureNaturalWidth(): number {
    const els = this.els;
    if (!els) return 0;
    // No layout engine (linkedom tests) — caller keeps width:auto.
    if (typeof window.getComputedStyle !== "function") return 0;
    const kids = [els.spin, els.check, els.dots, els.text, els.files, els.steps, els.meta, els.fold];
    const rootStyles = window.getComputedStyle(els.root);
    // Text is the one flexible child — its flexed box is either shrunk by
    // ellipsis or stretched by a previous width commit; neither is its
    // natural width. Pin it to max-content for the measurement only
    // (same task, restored before returning — no paint in between).
    const prevFlex = els.text.style.flex;
    const prevTextWidth = els.text.style.width;
    els.text.style.flex = "0 0 auto";
    els.text.style.width = "max-content";
    let kidsWidth = 0;
    let visible = 0;
    for (const kid of kids) {
      if (!kid || window.getComputedStyle(kid).display === "none") continue;
      // Outer (flex) size = border-box + horizontal margins — the dots
      // strip carries a negative trailing margin (letter-space offset)
      // that shrinks the pill exactly like the real layout does.
      // Fractional getBoundingClientRect, NOT offsetWidth: the integer
      // rounding loses sub-pixels (12.5px CJK glyphs), and an exact-fit
      // commit then sits a fraction short — flex squeezes the text and
      // the last character renders as the ellipsis instead.
      const kidStyle = window.getComputedStyle(kid);
      kidsWidth +=
        kid.getBoundingClientRect().width +
        toPx(kidStyle.marginLeft) +
        toPx(kidStyle.marginRight);
      visible++;
    }
    els.text.style.flex = prevFlex;
    els.text.style.width = prevTextWidth;
    // Zero-width but in-flow items (empty steps/meta) still take their
    // gaps — count them, mirroring the real layout.
    const gap = toPx(rootStyles.columnGap);
    const chrome =
      toPx(rootStyles.borderLeftWidth) +
      toPx(rootStyles.borderRightWidth) +
      toPx(rootStyles.paddingLeft) +
      toPx(rootStyles.paddingRight) +
      gap * Math.max(0, visible - 1);
    // +1px breathing room: text layout rounds down sub-pixels too — an
    // exact-fit commit can still shave the last glyph into an ellipsis.
    return Math.ceil(kidsWidth + chrome) + 1;
  }

  /** Mono timer only — the step dots carry progress; prompt has no meta. */
  private renderMeta(): void {
    const els = this.els;
    if (!els) return;
    if (this.mode.kind !== "task" || this.folded) {
      els.meta.textContent = "";
      return;
    }
    els.meta.textContent =
      this.runningSince != null
        ? formatElapsed(Date.now() - this.runningSince)
        : "";
  }

  private syncTimer(): void {
    const ticking =
      this.mode.kind === "task" && !this.folded && this.runningSince != null;
    if (ticking) {
      if (this.timer == null) {
        this.timer = setInterval(() => {
          if (!this.els || this.els.root.hidden) return;
          this.renderMeta();
          // The timer text widens as it grows (0:04 → 1:07:33) — re-commit
          // so the wider meta never squeezes the step text into ellipsis.
          this.syncWidth();
        }, 1000);
      }
    } else {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
