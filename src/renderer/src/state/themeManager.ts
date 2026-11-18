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
