import "./effort-seg.css";

/** Renderer mirror of the reasoning-effort dial (src/llm/reasoningEffort.ts). */
export type ReasoningEffortLevel = "off" | "low" | "medium" | "high" | "max";

/** Ordered dial positions with UI copy (shared by composer / settings / loops). */
export const EFFORT_SEG_LEVELS: ReadonlyArray<{
  id: ReasoningEffortLevel;
  short: string;
  name: string;
  hint: string;
}> = [
  { id: "off", short: "OFF", name: "Off", hint: "Thinking disabled" },
  { id: "low", short: "LOW", name: "Low", hint: "Light thinking · default" },
  { id: "medium", short: "MED", name: "Medium", hint: "Balanced depth (Kimi / GLM map to high)" },
  { id: "high", short: "HIGH", name: "High", hint: "Deep thinking" },
  { id: "max", short: "MAX", name: "Max", hint: "Full-strength thinking" },
];

/**
 * Five-level segmented picker (OFF / LOW / MED / HIGH / MAX). Pure visual
 * component: the owner persists level changes via `onSelect`; programmatic
 * updates (`setLevel`) never fire the callback. ← / → move the selection
 * when the control has focus.
 * `setDisabled` freezes the dial (read-only inspection, e.g. while a turn
 * runs): clicks and arrow keys are ignored and the level stays painted.
 */
export class EffortSegView {
  readonly root: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly buttons = new Map<ReasoningEffortLevel, HTMLButtonElement>();
  private readonly onSelect: (level: ReasoningEffortLevel) => void;
  private level: ReasoningEffortLevel = "low";
  private disabledState = false;

  constructor(options: {
    onSelect: (level: ReasoningEffortLevel) => void;
    ariaLabel?: string;
  }) {
    this.onSelect = options.onSelect;
    this.root = document.createElement("div");
    this.root.className = "effort-seg";
    this.root.setAttribute("role", "radiogroup");
    this.root.setAttribute(
      "aria-label",
      options.ariaLabel ?? "Effort",
    );

    this.thumb = document.createElement("span");
    this.thumb.className = "effort-seg-thumb";
    this.thumb.setAttribute("aria-hidden", "true");
    this.root.append(this.thumb);

    for (const level of EFFORT_SEG_LEVELS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "effort-seg-item" + (level.id === "max" ? " is-max" : "");
      button.textContent = level.short;
      button.title = `${level.name} — ${level.hint}`;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", "false");
      button.setAttribute("tabindex", "-1");
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.disabledState) return;
        this.setLevelInternal(level.id);
        this.onSelect(level.id);
      });
      this.buttons.set(level.id, button);
      this.root.append(button);
    }

    this.root.addEventListener("keydown", (event) => {
      if (this.disabledState) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const order = EFFORT_SEG_LEVELS.map((entry) => entry.id);
      const index = order.indexOf(this.level);
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      const nextIndex = Math.min(
        order.length - 1,
        Math.max(0, index + delta),
      );
      const next = order[nextIndex];
      if (next === undefined || next === this.level) return;
      this.setLevelInternal(next);
      this.onSelect(next);
    });

    this.setLevelInternal("low");
  }

  getLevel(): ReasoningEffortLevel {
    return this.level;
  }

  /** Programmatic update — mirrors persisted state; never fires onSelect. */
  setLevel(level: ReasoningEffortLevel): void {
    this.setLevelInternal(level);
  }

  /** Freeze interaction; the painted level stays visible for inspection. */
  setDisabled(disabled: boolean): void {
    this.disabledState = disabled;
    for (const button of this.buttons.values()) {
      button.disabled = disabled;
    }
  }

  focus(): void {
    this.buttons.get(this.level)?.focus();
  }

  private setLevelInternal(level: ReasoningEffortLevel): void {
    this.level = level;
    const index = EFFORT_SEG_LEVELS.findIndex((entry) => entry.id === level);
    this.thumb.style.setProperty("--i", String(index < 0 ? 1 : index));
    this.root.classList.toggle("is-gold", level === "max");
    /* data-level keys the per-level solid thumb/label palette; is-gold
       keeps owning MAX so its gold treatment stays untouched. */
    this.root.dataset.level = level;
    for (const [id, button] of this.buttons) {
      const checked = id === level;
      button.setAttribute("aria-checked", checked ? "true" : "false");
      button.setAttribute("tabindex", checked ? "0" : "-1");
    }
  }
}
