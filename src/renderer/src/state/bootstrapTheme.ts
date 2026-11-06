import { applyTheme } from "./themeManager.js";

/**
 * Apply the persisted theme id + accent override on app load. Failures
 * degrade to the default theme — tokens.css already renders the classic
 * look without any JS.
 */
export async function bootstrapThemeFromSettings(): Promise<void> {
  try {
    const settings = await window.jellybot?.getWorkspaceSettings?.();
    if (settings) {
      applyTheme(settings.themeId, settings.accentColor ?? null);
    }
  } catch (error) {
    console.error("[renderer] failed to bootstrap theme", error);
  }
}
