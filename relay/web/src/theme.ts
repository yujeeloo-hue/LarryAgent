import { buttonPaletteTokens } from "../../../src/renderer/src/state/buttonPalette.js";

/** Initialize Relay's fixed Light palette and discard the retired preference. */
export function initTheme(): void {
  document.documentElement.dataset.theme = "light";
  const tokens = buttonPaletteTokens("#006bd6", true);
  for (const [key, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(key, value);
  }

  const color = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (color) color.content = "#f8fafc";
  const status = document.querySelector<HTMLMetaElement>(
    'meta[name="apple-mobile-web-app-status-bar-style"]',
  );
  if (status) status.content = "default";

  try {
    localStorage.removeItem("larryRemote.theme");
  } catch {
    // Storage may be unavailable; Light does not depend on persisted state.
  }
}
