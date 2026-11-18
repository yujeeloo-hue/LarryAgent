import { applyTheme } from "./themeManager.js";

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
