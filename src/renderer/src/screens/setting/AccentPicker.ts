import { Check, Pipette } from "lucide";
import { createLucideIcon } from "../../ui/icons.js";
import { createLucideIcon as createOriginalIcon } from "../../ui/originalIcons.js";
import {
  ACCENT_PRESETS,
  contrastRatio,
  deriveOnAccent,
  getTheme,
  isAccentPresetId,
  resolveAccentHex,
  themeDefaultAccent,
} from "../../state/theme.js";
import { readThemeId } from "../../state/themeManager.js";

/** "auto" (theme default) | preset id | custom "#rrggbb". */
export type AccentValue = string;

const AUTO: AccentValue = "auto";
const CUSTOM: AccentValue = "custom-selection";

/** Effective text surface per theme for the contrast readout. */
const THEME_SURFACE: Record<string, string> = {
  dark: "#141414",
  light: "#ffffff",
};

function currentThemeId(): string {
  return readThemeId();
}

/**
 * Highlight color picker (Settings → Appearance): Auto swatch + per-theme
 * preset pairs + a native color-input Custom swatch, plus a live meta line
 * (hex + WCAG contrast vs the active theme's surface). Mirrors the
 * `HTMLInputElement` surface SettingDropdown uses: `.value` get/set and a
 * `change` event.
 *
 * Contrast is advisory only — low ratios warn (amber), never block.
 */
export class AccentPicker extends EventTarget {
  /** Root element — includes the meta readout line. */
  readonly el: HTMLElement;
  private readonly row: HTMLElement;
  private readonly metaDot: HTMLElement;
  private readonly metaHex: HTMLElement;
  private readonly metaText: HTMLElement;
  private readonly customSwatch: HTMLLabelElement;
  private readonly customInput: HTMLInputElement;
  private readonly customCheck: HTMLElement;
  /** Last custom hex picked (retained so re-selecting Custom restores it). */
  private customHex = "";
  private _value: AccentValue = AUTO;

  constructor() {
    super();

    this.el = document.createElement("div");
    this.el.className = "setting-accent";

    this.row = document.createElement("div");
    this.row.className = "setting-swatch-row";
    this.row.setAttribute("role", "radiogroup");
    this.row.setAttribute("aria-label", "Highlight color");

    // ── Auto (theme default) ──
    const auto = this.buildSwatch("auto", "Auto — follow the theme default");
    auto.classList.add("setting-swatch-auto");
    const autoDot = document.createElement("span");
    autoDot.className = "setting-swatch-dot setting-swatch-split";
    auto.append(autoDot, this.buildCheck());
    auto.addEventListener("click", () => this.select(AUTO));
    this.row.append(auto);

    const sep = document.createElement("span");
    sep.className = "setting-swatch-sep";
    sep.setAttribute("aria-hidden", "true");
    this.row.append(sep);

    // ── Presets ──
    for (const preset of ACCENT_PRESETS) {
      const swatch = this.buildSwatch(
        preset.id,
        `${preset.name} — ${preset.dark} / ${preset.light}`,
      );
      const dot = document.createElement("span");
      dot.className = "setting-swatch-dot";
      swatch.append(dot, this.buildCheck());
      swatch.addEventListener("click", () => this.select(preset.id));
      this.row.append(swatch);
    }

    // ── Custom (native color input) ──
    this.customSwatch = document.createElement("label");
    this.customSwatch.className = "setting-swatch setting-swatch-custom";
    this.customSwatch.dataset.preset = "custom";
    this.customSwatch.title = "Custom — pick any color";
    this.customSwatch.setAttribute("role", "radio");
    this.customSwatch.setAttribute("aria-checked", "false");
    const ring = document.createElement("span");
    ring.className = "setting-swatch-ring";
    ring.setAttribute("aria-hidden", "true");
    const customDot = document.createElement("span");
    customDot.className = "setting-swatch-dot setting-swatch-custom-dot";
    customDot.append(createOriginalIcon(Pipette, { size: 12 }));
    this.customCheck = this.buildCheck();
    this.customInput = document.createElement("input");
    this.customInput.type = "color";
    this.customInput.value = "#b695f5";
    this.customInput.setAttribute("aria-label", "Custom highlight color");
    this.customInput.addEventListener("input", () => {
      this.customHex = this.customInput.value.toLowerCase();
      this.select(CUSTOM);
    });
    this.customSwatch.append(ring, customDot, this.customCheck, this.customInput);
    this.row.append(this.customSwatch);

    this.el.append(this.row);

    // ── Meta readout: hex + WCAG contrast vs the theme surface ──
    const meta = document.createElement("span");
    meta.className = "setting-accent-meta";
    this.metaDot = document.createElement("span");
    this.metaDot.className = "setting-accent-dot";
    this.metaDot.setAttribute("aria-hidden", "true");
    this.metaHex = document.createElement("span");
    this.metaHex.className = "setting-accent-hex";
    this.metaText = document.createElement("span");
    meta.append(this.metaDot, this.metaHex, this.metaText);
    this.el.append(meta);

    this.render();
  }

  /** Repaint after the active theme changed (preset pairs swap variant). */
  refresh(): void {
    this.render();
  }

  private buildSwatch(id: string, title: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "setting-swatch";
    button.dataset.preset = id;
    button.title = title;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    return button;
  }

  private buildCheck(): HTMLElement {
    const check = document.createElement("span");
    check.className = "setting-swatch-check";
    check.setAttribute("aria-hidden", "true");
    check.append(createLucideIcon(Check, { size: 13, strokeWidth: 3 }));
    return check;
  }

  /** Current value: "auto" | preset id | "#rrggbb". */
  get value(): AccentValue {
    return this._value;
  }

  set value(next: AccentValue) {
    this._value = this.normalize(next);
    if (this.isCustomHex(this._value) && this.customHex !== this._value) {
      this.customHex = this._value;
      this.customInput.value = this._value;
    }
    this.render();
  }

  private normalize(next: string): AccentValue {
    if (next === AUTO || isAccentPresetId(next)) return next;
    if (/^#[0-9a-fA-F]{6}$/.test(next)) return next.toLowerCase();
    return AUTO;
  }

  private isCustomHex(value: string): boolean {
    return /^#[0-9a-f]{6}$/.test(value);
  }

  private select(next: AccentValue): void {
    if (next === CUSTOM) {
      if (!this.customHex) return; // nothing picked yet — input drives this
      this._value = this.customHex;
    } else {
      this._value = next;
    }
    this.render();
    this.dispatchEvent(new Event("change"));
  }

  /** Repaint selection, preset dots, and the contrast meta line. */
  private render(): void {
    const themeId = currentThemeId();
    const theme = getTheme(themeId);
    const selected = this._value;
    const isCustom = this.isCustomHex(selected);

    this.row.querySelectorAll<HTMLElement>(".setting-swatch").forEach((el) => {
      const id = el.dataset.preset ?? "";
      const active =
        id === "auto"
          ? selected === AUTO
          : id === "custom"
            ? isCustom
            : id === selected;
      el.classList.toggle("is-selected", active);
      el.setAttribute("aria-checked", String(active));
    });
    this.customSwatch.classList.toggle("is-picked", isCustom);
    if (isCustom) {
      this.customSwatch.style.setProperty(
        "--swatch-custom",
        this.customHex || selected,
      );
    } else {
      this.customSwatch.style.removeProperty("--swatch-custom");
    }
    // Custom check color follows the picked fill, not the active accent.
    const customFill = isCustom ? selected : this.customHex;
    if (customFill) {
      this.customCheck.style.color = deriveOnAccent(customFill);
    }

    // Auto previews both theme defaults; presets paint their active variant.
    this.row
      .querySelectorAll<HTMLElement>(".setting-swatch[data-preset]")
      .forEach((el) => {
        const dot = el.querySelector<HTMLElement>(".setting-swatch-dot");
        if (!dot) return;
        if (el.dataset.preset === AUTO) {
          dot.style.background = `linear-gradient(135deg, ${themeDefaultAccent(getTheme("dark"))} 0 50%, ${themeDefaultAccent(getTheme("light"))} 50% 100%)`;
          return;
        }
        const preset = ACCENT_PRESETS.find((p) => p.id === el.dataset.preset);
        if (!preset) return;
        dot.style.background =
          themeId === "light" ? preset.light : preset.dark;
      });

    // Meta line.
    const hex = resolveAccentHex(selected, theme.id) ?? themeDefaultAccent(theme);
    const surface = THEME_SURFACE[themeId] ?? "#141414";
    const ratio = contrastRatio(hex, surface);
    const ok = ratio >= 4.5;
    this.metaDot.classList.toggle("is-ok", ok);
    this.metaDot.classList.toggle("is-warn", !ok);
    this.metaHex.textContent = hex;
    const kind =
      selected === AUTO
        ? "Auto · theme default"
        : isCustom
          ? "Custom"
          : (ACCENT_PRESETS.find((p) => p.id === selected)?.name ?? "");
    this.metaText.textContent =
      `${kind} · ${ratio.toFixed(1)}:1 contrast${ok ? "" : " · low as text"}`;

    // Check glyph color on the selected solid swatch.
    this.row
      .querySelectorAll<HTMLElement>(".setting-swatch.is-selected .setting-swatch-check")
      .forEach((el) => {
        el.style.color = deriveOnAccent(hex);
      });
  }
}
