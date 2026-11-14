import {
  estimateTurnDurationMs,
  formatTurnDuration,
} from "../turnDuration.js";

/**
 * End-of-turn duration footer (presentation only).
 * Copy avoids the word "turn": `Completed · 1m 23s`.
 * Optional provider balance line (e.g. DeepSeek) below.
 */
export function createTurnEndedView(
  durationMs: number,
  balanceText?: string | null,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "turn-ended";

  const duration = document.createElement("div");
  duration.className = "turn-ended-duration";
  duration.textContent = `Completed · ${formatTurnDuration(durationMs)}`;
  root.append(duration);

  const trimmed = balanceText?.trim();
  if (trimmed) {
    const balance = document.createElement("div");
    balance.className = "turn-ended-balance";
    balance.textContent = trimmed;
    root.append(balance);
  }

  return root;
}

export function createTurnEndedViewFromMessages(
  turn: Array<{ createdAt?: number }>,
  balanceText?: string | null,
): HTMLElement | null {
  const durationMs = estimateTurnDurationMs(turn);
  if (durationMs === null) return null;
  return createTurnEndedView(durationMs, balanceText);
}
