import {
  COMPOSER_DRAFT_KEY,
  getComposerPrefs,
  seedComposerPrefsDefaults,
  setComposerPrefsFor,
  type ComposerRunMode,
} from "./sessionComposerPrefs.js";

export type { ComposerRunMode };

const MODE_ORDER: ComposerRunMode[] = ["agent", "ask", "plan"];

export function getComposerRunMode(): ComposerRunMode {
  return getComposerPrefs(COMPOSER_DRAFT_KEY).runMode;
}

export function initComposerRunMode(next: ComposerRunMode): void {
  if (next !== "agent" && next !== "ask" && next !== "plan") return;
  seedComposerPrefsDefaults({ runMode: next });
  setComposerPrefsFor(COMPOSER_DRAFT_KEY, { runMode: next });
}

export function applyComposerRunModeLocal(next: ComposerRunMode): void {
  if (next !== "agent" && next !== "ask" && next !== "plan") return;
  if (getComposerRunMode() === next) return;
  setComposerPrefsFor(COMPOSER_DRAFT_KEY, { runMode: next });
}

export function setComposerRunMode(next: ComposerRunMode): void {
  if (getComposerRunMode() === next) return;
  setComposerPrefsFor(COMPOSER_DRAFT_KEY, { runMode: next });
}

export function cycleComposerRunMode(): ComposerRunMode {
  const idx = MODE_ORDER.indexOf(getComposerRunMode());
  const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length] ?? "agent";
  setComposerRunMode(next);
  return getComposerRunMode();
}

export function isPlanModeEnabled(): boolean {
  return getComposerRunMode() === "plan";
}

