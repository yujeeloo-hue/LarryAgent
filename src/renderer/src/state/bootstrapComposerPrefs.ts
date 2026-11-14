import { seedComposerPrefsDefaults, type ComposerRunMode } from "./sessionComposerPrefs.js";
import { setComposerVoiceMode } from "./composerVoiceModeState.js";

/**
 * Seed process-wide composer defaults (Run Mode / Infinite / Reasoning Max)
 * from settings.json once at startup. These are the New Task draft starting
 * values and the fallback for sessions with un-pinned prefs (schema v14
 * NULL semantics). Draft Infinite / Reasoning Max changes write back to
 * settings.json (they ARE the defaults now); Run Mode does not.
 * The global voice-mode flag restores here too (no persist echo).
 */
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
    // Draft stays unpinned → resolves to the defaults above; pinned onto the
    // new session row at creation time (NewTaskController).
  } catch (err) {
    console.error("[composer] bootstrap prefs failed", err);
  }
}
