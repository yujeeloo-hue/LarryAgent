/**
 * ThemeManager — applies a theme to the live document and keeps the
 * persisted id in sync via the settings bridge.
 *
 * Mechanism: `<html data-theme="…">` + a single injected <style id="theme-overrides">
 * holding the theme's variable block. styles/tokens.css keeps the default
 * values on :root, so the app renders the classic dark look even before this
 * module runs (zero-regression guarantee).
 *
 * The optional accent override (Settings → Appearance → Highlight color)
 * rewrites accent tokens and the derived semantic button palette by appending a
 * later block inside the same element, so it always wins over the theme's
 * own values and is dropped entirely when unset (Auto = theme default).
 *
 * Dark islands (FSM Graph Editor + the overlays it spawns) append a final
 * scoped block that re-declares the Dark token set on [data-dark-island]
 * roots, keeping those workbenches dark under the Light theme. See
 * darkIslandCss in theme.ts.
 */
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

/** Current accent override; null = Auto (theme default accent). */
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

/** Re-apply the accent override on the already-active theme. */
export function applyAccentOverride(accentColor: string | null): void {
  currentAccent = accentColor ?? null;
  renderStyle(readThemeId());
}

/** Read the theme id currently applied on <html>, defaulting to `dark`. */
export function readThemeId(): ThemeId {
  const raw = document.documentElement.dataset.theme;
  return isThemeId(raw) ? raw : DEFAULT_THEME_ID;
}
