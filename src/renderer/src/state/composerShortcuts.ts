/**
 * Cmd+Shift+M in the composer: toggle the "power combo" for one target.
 *
 * - Off (anything except Infinite+Max) → Infinite switch + Reasoning Max on.
 * - On (Infinite + Reasoning Max)     → both off.
 *
 * The run mode (Auto/Ask/Plan) is NOT changed — Infinite is a switch, not a
 * mode. The target is per-session: a conversation passes its sessionId, New
 * Task passes COMPOSER_DRAFT_KEY (local only, pinned at session creation).
 * Session targets persist both flags in one atomic agent:setComposerPrefs
 * call (no settings.json writes).
 */
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

  // One keyed-store update → one atomic IPC for session targets.
  setComposerPrefsFor(key, {
    infinite: next,
    reasoningEffort: next ? "max" : "low",
  });
}
