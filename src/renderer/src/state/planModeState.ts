/**
 * @deprecated Composer run mode is per-session now — use
 * `state/sessionComposerPrefs.ts` with a session key (or COMPOSER_DRAFT_KEY
 * for New Task). This shell forwards to the draft key so legacy callers
 * (tests, bootstrap) keep working.
 *
 * Old semantics (process-wide composer run mode persisted to settings.json)
 * remain only as the *default* seeded at bootstrap.
 */
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

/**
 * @deprecated Seed defaults via seedComposerPrefsDefaults in
 * sessionComposerPrefs. Old semantics: set the process-wide value directly —
 * mirrored here by pinning the draft (local only, no IPC).
 */
export function initComposerRunMode(next: ComposerRunMode): void {
  if (next !== "agent" && next !== "ask" && next !== "plan") return;
  seedComposerPrefsDefaults({ runMode: next });
  setComposerPrefsFor(COMPOSER_DRAFT_KEY, { runMode: next });
}

/** @deprecated Use setComposerPrefsFor(COMPOSER_DRAFT_KEY, { runMode }). */
export function applyComposerRunModeLocal(next: ComposerRunMode): void {
  if (next !== "agent" && next !== "ask" && next !== "plan") return;
  if (getComposerRunMode() === next) return;
  setComposerPrefsFor(COMPOSER_DRAFT_KEY, { runMode: next });
}

/** @deprecated Draft-local only; does NOT write settings.json. */
export function setComposerRunMode(next: ComposerRunMode): void {
  if (getComposerRunMode() === next) return;
  setComposerPrefsFor(COMPOSER_DRAFT_KEY, { runMode: next });
}

/** @deprecated Cycles the draft key only. */
export function cycleComposerRunMode(): ComposerRunMode {
  const idx = MODE_ORDER.indexOf(getComposerRunMode());
  const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length] ?? "agent";
  setComposerRunMode(next);
  return getComposerRunMode();
}

/** @deprecated True when the draft key's mode is plan. */
export function isPlanModeEnabled(): boolean {
  return getComposerRunMode() === "plan";
}

