import {
  DEFAULT_DEV_MODE_PREFERENCES, DEV_MODE_FONT_FAMILIES, normalizeDevModePreferences,
  type DevModePreferences,
} from "../../../settings/devModePreferences.js";

export const DEV_MODE_EDITOR_PALETTES = {
  light: { background: "#ffffff", text: "#26334d", keyword: "#a00083", string: "#00764e", function: "#6946a7" },
  dark: { background: "#080808", text: "#e4e9f2", keyword: "#ff6edb", string: "#57e6ad", function: "#b49aff" },
  contrast: { background: "#000000", text: "#ffffff", keyword: "#ffb8ee", string: "#dcff77", function: "#78edff" },
} as const;

let preferences: DevModePreferences = { ...DEFAULT_DEV_MODE_PREFERENCES };
const preferenceListeners = new Set<() => void>();

export function setDevModePreferences(value: unknown): void {
  preferences = normalizeDevModePreferences(value);
  for (const listener of preferenceListeners) listener();
}

export function subscribeDevModePreferences(listener: () => void): () => void {
  preferenceListeners.add(listener);
  return () => { preferenceListeners.delete(listener); };
}

export function getDevModeLiveCodingEnabled(): boolean {
  return preferences.liveCoding;
}

export function getDevModeEditorFont(value: DevModePreferences = preferences): { fontFamily: string; fontSize: number } {
  return { fontFamily: DEV_MODE_FONT_FAMILIES[value.fontFamily], fontSize: value.fontSize };
}

export function getDevModeEditorPalette(syntaxTheme = preferences.syntaxTheme, appTheme = document.documentElement.dataset.theme): keyof typeof DEV_MODE_EDITOR_PALETTES {
  return syntaxTheme === "auto" ? (appTheme === "light" ? "light" : "dark") : syntaxTheme;
}
