/**
 * iterationProtectTokenRatio bounds + `/compact <keep>` argument parsing —
 * the single source shared by the settings resolver, the manual /compact
 * override validation (main sessionRuntime), and the composer slash layer
 * (renderer). Keep this module environment-free (no node imports): both the
 * main and web tsconfig programs compile it.
 *
 * Semantics of the ratio: newest model iterations stay raw while their
 * cumulative tokens stay under ratio × context limit; everything older is
 * summarized by the compaction pass.
 */

/** Upper bound for a protect/keep ratio (mirrors the settings range). */
export const PROTECT_TOKEN_RATIO_MAX = 0.9;

/** Settings-value check: finite ratio within (0, 0.9]. */
export function isValidProtectTokenRatio(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= PROTECT_TOKEN_RATIO_MAX
  );
}

/**
 * Parse a `/compact <keep>` argument: one plain decimal ratio in bounds
 * ("0.1", ".5", "0.35"). Null for anything else — "10", "0.95", "0.1x",
 * "--force", "keep 0.1" — so the composer can surface a usage hint instead
 * of sending the text to the model.
 */
export function parseProtectTokenRatioArg(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return isValidProtectTokenRatio(value) ? value : null;
}
