
export type Phase = string;

export type PlanPhase = Phase;

export function parsePhase(raw: unknown): Phase | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

export function isPhase(value: string | null | undefined): value is Phase {
  return typeof value === "string" && value.trim().length > 0;
}

