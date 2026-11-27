
import { buttonPaletteCss } from "./buttonPalette.js";

export type ThemeId = "dark" | "light";

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  tokens: Record<string, string>;
}


const CODE_SURFACE_TOKENS = {
  "--code-fg": "#e8e8e8",
  "--code-fg-muted": "#9a9a9a",
  "--code-border": "rgba(255, 255, 255, 0.08)",
  "--code-surface": "#0d0d0d",
} as const;

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

const DARK_STATUS_TOKENS = {
  "--success": "#3fb950",
  "--success-text": "#6dca8c",
  "--success-bg": "rgba(63, 185, 80, 0.14)",
  "--warn": "#d29922",
  "--warn-text": "#e0a33a",
  "--warn-bg": "rgba(210, 153, 34, 0.12)",
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
    "--shadow-rgb": "0, 0, 0",
    ...DARK_STATUS_TOKENS,
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
    "--bg": "#f8fafc",
    "--bg-elevated": "#ffffff",
    "--bg-sidebar": "rgba(255, 255, 255, 0.86)",
    "--bg-main": "rgba(255, 255, 255, 0.97)",
    "--fg": "#17202b",
    "--fg-muted": "#536171",
    "--shimmer-hi": "#a9b0b8",
    "--border": "rgba(18, 67, 117, 0.13)",
    "--hover": "rgba(0, 122, 255, 0.07)",
    "--active": "rgba(0, 122, 255, 0.12)",
    "--accent": "#006bd6",
    "--danger": "#c62828",
    "--danger-bg": "rgba(198, 40, 40, 0.1)",
    "--danger-soft": "rgba(198, 40, 40, 0.16)",
    "--danger-faint": "rgba(198, 40, 40, 0.5)",
    "--unread": "#2563eb",
    "--unread-ring": "rgba(37, 99, 235, 0.3)",
    "--spinner-track": "rgba(0, 0, 0, 0.12)",
    "--focus-border": "#4e6f91",
    "--hairline": "#e7edf5",
    "--divider": "rgba(18, 67, 117, 0.12)",
    "--tint-rgb": "0, 0, 0",
    "--shade-rgb": "93, 116, 143",
    "--accent-rgb": "0, 107, 214",
    "--on-accent": "#ffffff",
    "--on-gold": "#1a1408",
    "--surface-2": "#eef4fa",
    "--fg-dim": "#5f6e7f",
    "--row-hover": "rgba(0, 122, 255, 0.07)",
    "--scrim": "rgba(12, 31, 52, 0.3)",
    "--shadow-lg": "0 8px 24px rgba(18, 52, 86, 0.14)",
    "--shadow-xl": "0 12px 32px rgba(18, 52, 86, 0.17)",
    "--shadow-rgb": "18, 52, 86",
    ...LIGHT_STATUS_TOKENS,
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

export interface AccentPreset {
  id: string;
  name: string;
  dark: string;
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

export function isAccentPresetId(value: unknown): boolean {
  return typeof value === "string" && ACCENT_PRESETS.some((p) => p.id === value);
}

export function isAccentColorValue(value: unknown): value is string {
  return (
    isAccentPresetId(value) ||
    (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value))
  );
}

export function themeDefaultAccent(theme: ThemeDefinition): string {
  return theme.tokens["--accent"]!;
}

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

export function deriveOnAccent(hex: string): string {
  return relativeLuminance(hex) > 0.2 ? "#111111" : "#ffffff";
}

function tokenDecls(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
}

const BUBBLE_USER_MIX = {
  dark: { base: [18, 24, 26], amt: 0.11, alpha: 0.92, borderA: 0.35 },
  light: { base: [255, 255, 255], amt: 0.09, alpha: 1, borderA: 0.26 },
} as const;

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

function accentTokenDecls(hex: string, light: boolean): string {
  const n = parseInt(hex.slice(1), 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  const bubble = bubbleUserTokens(hex, light);
  return `--accent:${hex};--accent-rgb:${rgb};--on-accent:${deriveOnAccent(hex)};${tokenDecls(bubble)}${buttonPaletteCss(hex, light)}`;
}

export function themeToCss(theme: ThemeDefinition): string {
  return `:root[data-theme="${theme.id}"]{${tokenDecls(theme.tokens)}${buttonPaletteCss(theme.tokens["--accent"]!, theme.id === "light")}}`;
}

export function accentOverrideCss(
  accentColor: string | null | undefined,
  themeId: ThemeId,
): string {
  const hex = resolveAccentHex(accentColor, themeId);
  if (!hex) return "";
  return `:root[data-theme="${themeId}"]{${accentTokenDecls(hex, themeId === "light")}}`;
}


export function darkIslandCss(
  themeId: ThemeId,
  accentColor: string | null | undefined,
): string {
  if (themeId === "dark") return "";
  const hex = resolveAccentHex(accentColor, "dark") ?? themeDefaultAccent(dark);
  return `:root[data-theme="${themeId}"] [data-dark-island]{color-scheme:dark;color:var(--fg);${tokenDecls(dark.tokens)}${accentTokenDecls(hex, false)}}`;
}
