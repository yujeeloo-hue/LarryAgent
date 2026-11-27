
export type ContextPillStepState = "done" | "current" | "todo";

export type ContextPillSnapshot = {
  running: boolean;
  lastUserText: string | null;
  lastUserFiles: string[] | null;
  progressText: string;
  promptVisible: boolean;
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
      done: number;
    };

export function pillStepState(status: string): ContextPillStepState {
  if (status === "completed") return "done";
  if (status === "in_progress") return "current";
  return "todo";
}

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

export function computeEditorStatusMode(
  snapshot: ContextPillSnapshot,
): ContextPillMode {
  if (!snapshot.running) return { kind: "hidden" };
  const text = snapshot.progressText.trim();
  if (!text) return { kind: "hidden" };
  return { kind: "status", text };
}

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

const FOLD_DOT_COUNT = 3;

const DONE_FADE_LABEL = "Done";
const DONE_FADE_DWELL_MS = 3000;
const DONE_FADE_ANIMATION = "devmode-ctxpill-leave";

const NOTICE_DEFAULT_MS = 3200;

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
  check: HTMLElement;
  dots: HTMLElement;
  text: HTMLElement;
  files: HTMLElement;
  steps: HTMLElement;
  meta: HTMLElement;
  fold: HTMLButtonElement | null;
};

function toPx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export class ContextPillController {
  private els: PillElements | null = null;
  private mode: ContextPillMode = { kind: "hidden" };
  private folded = false;
  private promptVisible: boolean | null = null;
  private manualFolded: boolean | null = null;
  private gate = true;
  private runningSince: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private doneActive = false;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private notice: { text: string; spinner: boolean } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private foldedBeforeNotice = false;
  private lastSnapshot: ContextPillSnapshot | null = null;

  constructor(
    private readonly options?: {
      computeMode?: (snapshot: ContextPillSnapshot) => ContextPillMode;
      foldable?: boolean;
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
    root.addEventListener("animationend", (event) => {
      const name = (event as AnimationEvent).animationName;
      if (name !== DONE_FADE_ANIMATION || !this.doneActive) return;
      this.doneActive = false;
      root.classList.remove("is-leaving");
      this.mode = { kind: "hidden" };
      this.render();
    });
    root.addEventListener("click", (event) => {
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

  setGate(visible: boolean): void {
    if (this.gate === visible) return;
    this.gate = visible;
    if (!visible) this.cancelDoneFade();
    this.render();
  }

  reset(): void {
    this.cancelNotice();
    this.cancelDoneFade();
    this.lastSnapshot = null;
    this.mode = { kind: "hidden" };
    this.runningSince = null;
    this.render();
  }

  showNotice(text: string, durationMs = NOTICE_DEFAULT_MS, options?: {
    spinner?: boolean;
  }): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.cancelNotice();
    this.cancelDoneFade();
    this.foldedBeforeNotice = this.folded;
    this.notice = { text: trimmed, spinner: options?.spinner === true };
    this.setFolded(false);
    this.noticeTimer = setTimeout(
      () => this.endNotice(),
      Math.max(600, durationMs),
    );
    this.render();
  }

  private endNotice(): void {
    this.noticeTimer = null;
    if (!this.notice) return;
    this.notice = null;
    const snapshot = this.lastSnapshot;
    if (snapshot) {
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

  private cancelNotice(): void {
    if (this.noticeTimer != null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.notice = null;
  }

  update(snapshot: ContextPillSnapshot): void {
    this.lastSnapshot = snapshot;
    if (this.notice) return;
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

  private enterDoneFade(): void {
    this.cancelDoneFade();
    this.doneActive = true;
    this.mode = { kind: "status", text: DONE_FADE_LABEL };
    this.doneTimer = setTimeout(() => this.startLeaveFade(), DONE_FADE_DWELL_MS);
  }

  private startLeaveFade(): void {
    this.doneTimer = null;
    if (!this.doneActive || !this.els) return;
    if (prefersReducedMotion()) {
      this.doneActive = false;
      this.mode = { kind: "hidden" };
      this.render();
      return;
    }
    this.els.root.classList.add("is-leaving");
  }

  private cancelDoneFade(): void {
    if (this.doneTimer != null) {
      clearTimeout(this.doneTimer);
      this.doneTimer = null;
    }
    if (!this.doneActive) return;
    this.doneActive = false;
    this.els?.root.classList.remove("is-leaving");
  }

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
    els.root.classList.toggle("is-running", this.runningSince != null);
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
      delete els.text.dataset.morphText;
      els.text.classList.remove("is-morph-in");
      els.text.textContent = mode.stepTitle ?? mode.title;
      els.root.title = focus;
      this.renderFilesBadge(null);
    }

    if (this.folded) {
      const snap = this.lastSnapshot;
      const promptText = snap?.lastUserText?.trim() ?? "";
      const files = snap?.lastUserFiles ?? null;
      const tooltip = promptText || (files && files.length > 0 ? files.join("\n") : "");
      if (tooltip) els.root.title = tooltip;
    }

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
    void els.text.offsetWidth;
    els.text.classList.add("is-morph-in");
  }

  private syncWidth(): void {
    const root = this.els?.root;
    if (!root || root.hidden) return;
    const next = this.measureNaturalWidth();
    if (!next) return;
    root.style.width = `${next}px`;
  }

  private measureNaturalWidth(): number {
    const els = this.els;
    if (!els) return 0;
    if (typeof window.getComputedStyle !== "function") return 0;
    const kids = [els.spin, els.check, els.dots, els.text, els.files, els.steps, els.meta, els.fold];
    const rootStyles = window.getComputedStyle(els.root);
    const prevFlex = els.text.style.flex;
    const prevTextWidth = els.text.style.width;
    els.text.style.flex = "0 0 auto";
    els.text.style.width = "max-content";
    let kidsWidth = 0;
    let visible = 0;
    for (const kid of kids) {
      if (!kid || window.getComputedStyle(kid).display === "none") continue;
      const kidStyle = window.getComputedStyle(kid);
      kidsWidth +=
        kid.getBoundingClientRect().width +
        toPx(kidStyle.marginLeft) +
        toPx(kidStyle.marginRight);
      visible++;
    }
    els.text.style.flex = prevFlex;
    els.text.style.width = prevTextWidth;
    const gap = toPx(rootStyles.columnGap);
    const chrome =
      toPx(rootStyles.borderLeftWidth) +
      toPx(rootStyles.borderRightWidth) +
      toPx(rootStyles.paddingLeft) +
      toPx(rootStyles.paddingRight) +
      gap * Math.max(0, visible - 1);
    return Math.ceil(kidsWidth + chrome) + 1;
  }

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
