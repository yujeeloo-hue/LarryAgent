import {
  accentOverrideCss,
  darkIslandCss,
  getTheme,
  isThemeId,
  themeToCss,
  DEFAULT_THEME_ID,
  type ThemeId,
} from "./theme.js";

const STYLE_ID = "theme-overrides";

let currentAccent: string | null = null;
let lastAppearance = "";

function reportAppearance(themeId: ThemeId): void {
  const bridge = window.jellybot;
  if (!bridge?.reportAppearance) return;
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--accent").trim();
  const onAccent = styles.getPropertyValue("--on-accent").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(accent) || !/^#[0-9a-fA-F]{6}$/.test(onAccent)) return;
  const payload = { dark: themeId === "dark", accent: accent.toLowerCase(), onAccent: onAccent.toLowerCase() };
  const key = `${payload.dark}:${payload.accent}:${payload.onAccent}`;
  if (key === lastAppearance) return;
  lastAppearance = key;
  try {
    bridge.reportAppearance(payload);
  } catch {
    lastAppearance = "";
  }
}

function renderStyle(themeId: ThemeId): void {
  const theme = getTheme(themeId);
  const nextCss =
    themeToCss(theme) +
    accentOverrideCss(currentAccent, theme.id) +
    darkIslandCss(theme.id, currentAccent);
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (
    document.documentElement.dataset.theme === theme.id &&
    style &&
    style.textContent === nextCss
  ) {
    return;
  }
  document.documentElement.dataset.theme = theme.id;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = nextCss;
  reportAppearance(isThemeId(themeId) ? themeId : DEFAULT_THEME_ID);
}

export function applyTheme(id: ThemeId, accentColor?: string | null): void {
  if (accentColor !== undefined) {
    currentAccent = accentColor ?? null;
  }
  renderStyle(isThemeId(id) ? id : DEFAULT_THEME_ID);
}

export function applyAccentOverride(accentColor: string | null): void {
  currentAccent = accentColor ?? null;
  renderStyle(readThemeId());
}

export function readThemeId(): ThemeId {
  const raw = document.documentElement.dataset.theme;
  return isThemeId(raw) ? raw : DEFAULT_THEME_ID;
}
