/**
 * Theme system — CSS variable sets applied on <html data-theme="...">.
 *
 * The default theme ("dark") mirrors styles/tokens.css exactly, so the app
 * looks unchanged out of the box. Switching themes rewrites the variable
 * values through an injected <style> element; component CSS keeps consuming
 * var(--…) tokens, so no component code needs to know about themes.
 */

import { buttonPaletteCss } from "./buttonPalette.js";

export type ThemeId = "dark" | "light";

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  /** CSS variable name (with leading "--") → value. */
  tokens: Record<string, string>;
}

/*
 * Surface polarity (--tint-rgb / --shade-rgb)
 *
 * Component CSS paints raised surfaces as `rgba(var(--tint-rgb), α)` and
 * recessed ones as `rgba(var(--shade-rgb), α)`. Themes only swap the RGB
 * triple, so every existing alpha keeps its exact weight while the direction
 * flips: white-on-dark for dark themes, black-on-light for the light theme.
 * `--shade-rgb` is a mid grey (not black) in the light theme, because the
 * recess alphas were tuned against dark backgrounds and pure black at those
 * weights reads as a smudge on white.
 *
 * Code surfaces deliberately opt out and stay dark in every theme —
 * highlight.js ships a single github-dark stylesheet, so a light code body
 * would lose token contrast.
 */

/** Shared by every theme — see the polarity note above. */
const CODE_SURFACE_TOKENS = {
  "--code-fg": "#e8e8e8",
  "--code-fg-muted": "#9a9a9a",
  "--code-border": "rgba(255, 255, 255, 0.08)",
  /* Terminal output island backdrop — matches rgba(0,0,0,.35) composited
     over --bg, so pinning it changes Dark by ~nothing. */
  "--code-surface": "#0d0d0d",
} as const;

/*
 * Composer send/stop face (task-composer.css nebula button).
 *
 * The glass face + glyph are theme-coupled, so they ride tokens; the three
 * nebula gradient families and the icon glow blooms are structural art and
 * live as a scoped :root[data-theme="light"] block in task-composer.css.
 * Dark values are the exact literals the button shipped with (zero drift).
 */
const SEND_FACE_TOKENS = {
  "--send-face-bg": "rgba(255, 255, 255, 0.1)",
  "--send-face-bg-hover": "rgba(255, 255, 255, 0.17)",
  "--send-face-bg-disabled": "rgba(255, 255, 255, 0.06)",
  "--send-face-border": "rgba(255, 255, 255, 0.22)",
  "--send-face-border-hover": "rgba(255, 255, 255, 0.32)",
  "--send-face-border-disabled": "rgba(255, 255, 255, 0.12)",
  "--send-face-inset": "rgba(255, 255, 255, 0.22)",
  "--send-face-inset-disabled": "rgba(255, 255, 255, 0.08)",
  "--send-icon": "#eefcff",
  "--send-icon-disabled": "rgba(238, 252, 255, 0.42)",
  "--send-glow-core": "rgba(255, 255, 255, 0.85)",
  "--send-glow-core-hover": "rgba(255, 255, 255, 0.95)",
  "--send-text-shadow": "0 1px 2px rgba(0, 24, 32, 0.45)",
} as const;

/** Light mist + light glass + deep system-blue glyph. */
const LIGHT_SEND_FACE_TOKENS = {
  "--send-face-bg": "rgba(255, 255, 255, 0.42)",
  "--send-face-bg-hover": "rgba(255, 255, 255, 0.6)",
  "--send-face-bg-disabled": "rgba(255, 255, 255, 0.28)",
  "--send-face-border": "rgba(0, 73, 146, 0.22)",
  "--send-face-border-hover": "rgba(0, 73, 146, 0.34)",
  "--send-face-border-disabled": "rgba(0, 73, 146, 0.12)",
  "--send-face-inset": "rgba(255, 255, 255, 0.8)",
  "--send-face-inset-disabled": "rgba(255, 255, 255, 0.45)",
  "--send-icon": "#003f80",
  "--send-icon-disabled": "rgba(0, 63, 128, 0.42)",
  "--send-glow-core": "rgba(255, 255, 255, 0.9)",
  "--send-glow-core-hover": "rgba(255, 255, 255, 0.95)",
  "--send-text-shadow": "none",
} as const;

/**
 * Status & semantic family (docs/theme-audit.md §2) — one named color per
 * meaning instead of the eleven reds / eight greens / seven golds the audit
 * found scattered across component CSS. Dark values keep exactly what the
 * audit measured (zero drift on dark surfaces); the light set deepens each
 * hue for WCAG AA contrast on near-white surfaces.
 */
const DARK_STATUS_TOKENS = {
  "--success": "#3fb950",
  "--success-text": "#6dca8c",
  "--success-bg": "rgba(63, 185, 80, 0.14)",
  "--warn": "#d29922",
  "--warn-text": "#e0a33a",
  "--warn-bg": "rgba(210, 153, 34, 0.12)",
  /* Gold FILL surfaces (MAX chip, gold pips). Text-semantic --warn-text is
     calibrated dark for AA body text, which reads as mud when used as a
     fill; fills get their own vivid amber that keeps --on-gold AA. */
  "--gold-fill": "#e2b340",
  "--danger-text": "#e5534b",
  "--danger-muted": "#e8a0a0",
  "--vcs-added": "#57ab5a",
  "--vcs-modified": "#d29922",
  "--vcs-deleted": "#e5534b",
  "--vcs-untracked": "#539bf5",
  "--vcs-renamed": "#d2a8ff",
  "--link": "#58a6ff",
  "--badge-gold": "#d6a94a",
  "--log-debug": "#8a8a8a",
  "--log-info": "#8ab4c8",
  "--log-warn": "#d4b06a",
  "--log-error": "#e08080",
} as const;

const LIGHT_STATUS_TOKENS = {
  "--success": "#1a7f37",
  "--success-text": "#1e7a3c",
  "--success-bg": "rgba(23, 122, 54, 0.12)",
  "--warn": "#9a6700",
  "--warn-text": "#8a6100",
  "--warn-bg": "rgba(154, 103, 0, 0.10)",
  /* Vivid orange amber — the user-visible "MAX is gold" signal. #452c00 on
     it reads 8.3:1 (AA); white reads 2.8:1, so Light pairs it with the
     near-black --on-gold instead of the dark-theme white flip. */
  "--gold-fill": "#f59e0b",
  "--danger-text": "#b91c1c",
  "--danger-muted": "#a63d44",
  "--vcs-added": "#1a7f37",
  "--vcs-modified": "#9a6700",
  "--vcs-deleted": "#cb2431",
  "--vcs-untracked": "#0969da",
  "--vcs-renamed": "#8250df",
  "--link": "#0969da",
  "--badge-gold": "#8a6100",
  "--log-debug": "#6e7178",
  "--log-info": "#0e7490",
  "--log-warn": "#8a6100",
  "--log-error": "#c62828",
} as const;

const dark: ThemeDefinition = {
  id: "dark",
  name: "Dark",
  description: "Default — the classic look.",
  tokens: {
    "--bg": "#141414",
    "--bg-elevated": "#141414",
    "--bg-sidebar": "rgba(0, 0, 0, 0.48)",
    "--bg-main": "rgba(8, 8, 8, 0.8)",
    "--fg": "#e8e8e8",
    "--fg-muted": "#9a9a9a",
    // Status-line shimmer bright stop (dark family: plain fg). See light below.
    "--shimmer-hi": "var(--fg)",
    "--border": "rgba(255, 255, 255, 0.045)",
    "--hover": "rgba(255, 255, 255, 0.06)",
    "--active": "rgba(255, 255, 255, 0.1)",
    "--accent": "#00e5ff",
    "--danger": "#f85149",
    "--danger-bg": "rgba(248, 81, 73, 0.14)",
    "--danger-soft": "rgba(248, 81, 73, 0.22)",
    "--danger-faint": "rgba(248, 81, 73, 0.55)",
    "--unread": "#3b82f6",
    "--unread-ring": "rgba(59, 130, 246, 0.35)",
    "--spinner-track": "rgba(255, 255, 255, 0.18)",
    "--focus-border": "#4a4a4a",
    "--hairline": "rgba(255, 255, 255, 0.02)",
    "--divider": "rgba(255, 255, 255, 0.08)",
    "--tint-rgb": "255, 255, 255",
    "--shade-rgb": "0, 0, 0",
    "--accent-rgb": "0, 229, 255",
    "--on-accent": "#111",
    "--on-gold": "#1a1408",
    "--surface-2": "#1b1b1b",
    "--fg-dim": "#6a6a6a",
    "--row-hover": "rgba(255, 255, 255, 0.05)",
    "--scrim": "rgba(0, 0, 0, 0.55)",
    "--shadow-lg": "0 8px 24px rgba(0, 0, 0, 0.45)",
    "--shadow-xl": "0 12px 32px rgba(0, 0, 0, 0.45)",
    /* Shadow pigment for multi-layer stacks (inset highlight + contact +
     * ambient) that --shadow-lg/xl can't express. */
    "--shadow-rgb": "0, 0, 0",
    ...DARK_STATUS_TOKENS,
    // User prompt bubbles — neon teal family; dark themes keep the night look.
    "--bubble-user-bg": "rgba(20, 38, 42, 0.92)",
    "--bubble-user-border": "rgba(64, 224, 224, 0.35)",
    ...CODE_SURFACE_TOKENS,
    ...SEND_FACE_TOKENS,
  },
};

const light: ThemeDefinition = {
  id: "light",
  name: "Light",
  description: "Crisp paper white with a system-blue accent.",
  tokens: {
    /* Cool paper base + white page. The rail is a genuinely translucent
       white layer; shell.css adds the soft highlight and frosted blur. */
    "--bg": "#f8fafc",
    "--bg-elevated": "#ffffff",
    "--bg-sidebar": "rgba(255, 255, 255, 0.86)",
    "--bg-main": "rgba(255, 255, 255, 0.97)",
    "--fg": "#17202b",
    "--fg-muted": "#536171",
    /* Status-line shimmer bright stop: light --fg sits DARKER than --fg-muted,
       so the sweep read as dimming (animation invisible). Lift it to a pale
       mix of fg-muted + 50% white instead. */
    "--shimmer-hi": "#a9b0b8",
    "--border": "rgba(18, 67, 117, 0.13)",
    "--hover": "rgba(0, 122, 255, 0.07)",
    "--active": "rgba(0, 122, 255, 0.12)",
    /* #007aff is the visual reference. The token is one step deeper so
       accent-colored text clears WCAG AA on the near-white canvas. */
    "--accent": "#006bd6",
    "--danger": "#c62828",
    "--danger-bg": "rgba(198, 40, 40, 0.1)",
    "--danger-soft": "rgba(198, 40, 40, 0.16)",
    "--danger-faint": "rgba(198, 40, 40, 0.5)",
    "--unread": "#2563eb",
    "--unread-ring": "rgba(37, 99, 235, 0.3)",
    "--spinner-track": "rgba(0, 0, 0, 0.12)",
    "--focus-border": "#4e6f91",
    /* Sidebar|main 1px rule. Opaque pale blue on purpose: it sits over
       no panel (composites straight onto the native window background), so
       a translucent black would go black whenever the native color is dark
       (e.g. window created dark, theme switched to light at runtime). */
    "--hairline": "#e7edf5",
    "--divider": "rgba(18, 67, 117, 0.12)",
    "--tint-rgb": "0, 0, 0",
    "--shade-rgb": "93, 116, 143",
    "--accent-rgb": "0, 107, 214",
    "--on-accent": "#ffffff",
    /* Gold fills (#e2b340 dark / #f59e0b light) both carry near-black text:
       9.4:1 and 8.5:1 (AA). The old light flip to white only fit the dim
       #8a6100 fill, which read as mud on the vivid fill the chip needs. */
    "--on-gold": "#1a1408",
    "--surface-2": "#eef4fa",
    "--fg-dim": "#5f6e7f",
    "--row-hover": "rgba(0, 122, 255, 0.07)",
    "--scrim": "rgba(12, 31, 52, 0.3)",
    "--shadow-lg": "0 8px 24px rgba(18, 52, 86, 0.14)",
    "--shadow-xl": "0 12px 32px rgba(18, 52, 86, 0.17)",
    "--shadow-rgb": "18, 52, 86",
    ...LIGHT_STATUS_TOKENS,
    // Bubbles follow the Light palette: pale system blue, dark body text.
    "--bubble-user-bg": "#e5f1ff",
    "--bubble-user-border": "rgba(0, 107, 214, 0.26)",
    ...CODE_SURFACE_TOKENS,
    ...LIGHT_SEND_FACE_TOKENS,
  },
};

export const THEMES: readonly ThemeDefinition[] = [dark, light];

export const DEFAULT_THEME_ID: ThemeId = "dark";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function getTheme(id: unknown): ThemeDefinition {
  return THEMES.find((t) => t.id === id) ?? dark;
}

/*
 * Highlight color (accent override) — Settings → Appearance.
 *
 * Persisted settings.accentColor is one of: a preset id below, a custom
 * `#rrggbb` hex, or unset (null = Auto, follow the theme default). Presets
 * carry a per-theme pair so switching Dark/Light swaps to the AA-tuned
 * variant of the same color family. Dark variants use cyberpunk neon hues;
 * custom hexes apply verbatim to both themes.
 */
export interface AccentPreset {
  id: string;
  name: string;
  /** Dark-surface variant. */
  dark: string;
  /** Light-surface variant (light theme). */
  light: string;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "teal", name: "Teal", dark: "#c8ff00", light: "#0e7d80" },
  { id: "blue", name: "Blue", dark: "#00e5ff", light: "#006bd6" },
  { id: "violet", name: "Violet", dark: "#b65cff", light: "#6d3fc4" },
  { id: "rose", name: "Rose", dark: "#ff3bd4", light: "#c02a6b" },
  { id: "amber", name: "Amber", dark: "#f5ff00", light: "#9a6700" },
  { id: "sapphire", name: "Sapphire", dark: "#4d7cff", light: "#2454d6" },
];

/** Whether a value is a known accent preset id. */
export function isAccentPresetId(value: unknown): boolean {
  return typeof value === "string" && ACCENT_PRESETS.some((p) => p.id === value);
}

/** Valid persisted accent value: preset id or `#rrggbb` (case-insensitive). */
export function isAccentColorValue(value: unknown): value is string {
  return (
    isAccentPresetId(value) ||
    (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value))
  );
}

/** Theme default accent hex (what Auto resolves to). */
export function themeDefaultAccent(theme: ThemeDefinition): string {
  return theme.tokens["--accent"]!;
}

/** Resolve an accentColor setting to a concrete hex for a theme; null = Auto. */
export function resolveAccentHex(
  accentColor: string | null | undefined,
  themeId: ThemeId,
): string | null {
  if (!accentColor) return null;
  const theme = getTheme(themeId);
  if (isAccentPresetId(accentColor)) {
    const preset = ACCENT_PRESETS.find((p) => p.id === accentColor)!;
    return themeId === "light" ? preset.light : preset.dark;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(accentColor)) return accentColor.toLowerCase();
  return null;
}

/* WCAG relative luminance — shared by --on-accent derivation and the
 * Settings contrast readout. */
function srgbChannel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return 0;
  return (
    0.2126 * srgbChannel((n >> 16) & 255) +
    0.7152 * srgbChannel((n >> 8) & 255) +
    0.0722 * srgbChannel(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Text color on an accent fill. Threshold ≈0.2 is the contrast crossover
 * where #111 and #fff score equally against the fill (both built-ins land
 * on their shipped pairs: #00e5ff→#111, #006bd6→#fff).
 */
export function deriveOnAccent(hex: string): string {
  return relativeLuminance(hex) > 0.2 ? "#111111" : "#ffffff";
}

/** Serialize a token map into `--name:value;` declarations. */
function tokenDecls(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
}

/**
 * User prompt bubble, accent-derived. The theme tokens above are the Auto
 * defaults (teal-family dark / pale-blue light); when an accent override is
 * active the bubble re-hues to follow it at the same visual weight:
 * a light accent wash (11% dark / 9% light) mixed toward a dark/white base,
 * plus an accent border at the shipped weights. Dark keeps the 0.92 fill
 * alpha so the clamp fade and page compositing behave exactly as before.
 */
const BUBBLE_USER_MIX = {
  dark: { base: [18, 24, 26], amt: 0.11, alpha: 0.92, borderA: 0.35 },
  light: { base: [255, 255, 255], amt: 0.09, alpha: 1, borderA: 0.26 },
} as const;

/** Accent-derived `--bubble-user-*` tokens for one hex (see above). */
export function bubbleUserTokens(
  hex: string,
  light: boolean,
): { "--bubble-user-bg": string; "--bubble-user-border": string } {
  const n = parseInt(hex.slice(1), 16);
  const accent = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const { base, amt, alpha, borderA } = light ? BUBBLE_USER_MIX.light : BUBBLE_USER_MIX.dark;
  const fill = accent.map((c, i) => Math.round(c * amt + base[i]! * (1 - amt)));
  return {
    "--bubble-user-bg": light
      ? "#" + fill.map((c) => c.toString(16).padStart(2, "0")).join("")
      : `rgba(${fill.join(", ")}, ${alpha})`,
    "--bubble-user-border": `rgba(${accent.join(", ")}, ${borderA})`,
  };
}

/**
 * Accent token declarations for one hex: accent + rgb triple + derived
 * on-accent ink + the button-only palette (`--button-*`) + the
 * accent-following user bubble (`--bubble-user-*`).
 */
function accentTokenDecls(hex: string, light: boolean): string {
  const n = parseInt(hex.slice(1), 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  const bubble = bubbleUserTokens(hex, light);
  return `--accent:${hex};--accent-rgb:${rgb};--on-accent:${deriveOnAccent(hex)};${tokenDecls(bubble)}${buttonPaletteCss(hex, light)}`;
}

/**
 * Serialize a theme's tokens into CSS variable declarations for injection,
 * e.g. `:root[data-theme="light"]{--bg:#f8fafc;…}`.
 */
export function themeToCss(theme: ThemeDefinition): string {
  return `:root[data-theme="${theme.id}"]{${tokenDecls(theme.tokens)}${buttonPaletteCss(theme.tokens["--accent"]!, theme.id === "light")}}`;
}

/**
 * Accent override block appended after the theme block (same element, later
 * in source order ⇒ wins the cascade at equal specificity). Overrides only
 * Accent tokens and the button-only palette follow the chosen hue; the
 * remaining theme tokens keep their values. Auto needs no override.
 */
export function accentOverrideCss(
  accentColor: string | null | undefined,
  themeId: ThemeId,
): string {
  const hex = resolveAccentHex(accentColor, themeId);
  if (!hex) return "";
  return `:root[data-theme="${themeId}"]{${accentTokenDecls(hex, themeId === "light")}}`;
}

/*
 * Dark islands — subtrees pinned to the Dark theme under every app theme.
 * The FSM Graph Editor is a night workspace by design (neon canvas, dark
 * chrome), so its screen root carries [data-dark-island] and re-declares
 * the full Dark token set when the app runs Light. Body-level floaters the
 * island spawns (hover tips, fixed menus, app select popups) must carry the
 * marker themselves: they escape the screen subtree for stacking reasons,
 * and CSS variables inherit down the DOM tree, not the layout tree.
 * color-scheme:dark keeps native controls (checkboxes, scrollbars, closed
 * selects) on the dark side too.
 */

/**
 * Dark-island re-pin for non-dark themes. Emitted after the theme + accent
 * blocks: every [data-dark-island] root re-declares the Dark token set,
 * with the Dark-variant accent (neon presets / same custom hex) when an
 * accent override is active. Returns "" for the dark theme — there the
 * root values already are the island values.
 */
export function darkIslandCss(
  themeId: ThemeId,
  accentColor: string | null | undefined,
): string {
  if (themeId === "dark") return "";
  const hex = resolveAccentHex(accentColor, "dark") ?? themeDefaultAccent(dark);
  // color:var(--fg) re-primes inheritance — tokens.css resolves `color` on
  // <body> (outside the island), so the subtree would keep the Light ink
  // even with every token re-declared.
  return `:root[data-theme="${themeId}"] [data-dark-island]{color-scheme:dark;color:var(--fg);${tokenDecls(dark.tokens)}${accentTokenDecls(hex, false)}}`;
}
