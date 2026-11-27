
export const PROTECT_TOKEN_RATIO_MAX = 0.9;

export function isValidProtectTokenRatio(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= PROTECT_TOKEN_RATIO_MAX
  );
}

export function parseProtectTokenRatioArg(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return isValidProtectTokenRatio(value) ? value : null;
}
