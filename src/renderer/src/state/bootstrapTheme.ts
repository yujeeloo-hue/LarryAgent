import { applyTheme } from "./themeManager.js";
import { setDevModePreferences } from "./devModePreferences.js";

export async function bootstrapThemeFromSettings(): Promise<void> {
  try {
    const settings = await window.jellybot?.getWorkspaceSettings?.();
    if (settings) {
      applyTheme(settings.themeId, settings.accentColor ?? null);
      setDevModePreferences(settings.devMode);
    }
  } catch (error) {
    console.error("[renderer] failed to bootstrap theme", error);
  }
}
