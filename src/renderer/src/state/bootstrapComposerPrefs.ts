import { seedComposerPrefsDefaults, type ComposerRunMode } from "./sessionComposerPrefs.js";
import { setComposerVoiceMode } from "./composerVoiceModeState.js";

export async function bootstrapComposerPrefsFromSettings(): Promise<void> {
  try {
    const snapshot = await window.jellybot?.getSettingsSnapshot?.();
    const settings = snapshot?.settings;
    if (!settings) return;
    const runMode: ComposerRunMode =
      settings.composerRunMode === "ask" || settings.composerRunMode === "plan"
        ? settings.composerRunMode
        : "agent";
    seedComposerPrefsDefaults({
      runMode,
      infinite: settings.composerInfinite === true,
      reasoningEffort: settings.reasoningEffort ?? "low",
    });
    setComposerVoiceMode(settings.composerVoiceMode === true, {
      persist: false,
    });
  } catch (err) {
    console.error("[composer] bootstrap prefs failed", err);
  }
}
