import {
  COMPOSER_DRAFT_KEY,
  getComposerPrefs,
  setComposerPrefsFor,
} from "./sessionComposerPrefs.js";

export function toggleInfiniteMaxCombo(
  key: string = COMPOSER_DRAFT_KEY,
): void {
  const prefs = getComposerPrefs(key);
  const on = prefs.infinite && prefs.reasoningEffort === "max";
  const next = !on;

  setComposerPrefsFor(key, {
    infinite: next,
    reasoningEffort: next ? "max" : "low",
  });
}
