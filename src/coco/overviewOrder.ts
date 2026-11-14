/** Overview cards below the runtime banner, in fixed display order. Empty cards are hidden. */
export type OverviewCardId = "decide" | "planning" | "flow" | "report" | "runs";
export const OVERVIEW_ORDER: readonly OverviewCardId[] = ["decide", "planning", "flow", "report", "runs"];

/** A report stays "new" until the user opens Reports, for at most one day. */
export const NEW_REPORT_MS = 86400000;
export function isNewReport(at: number, seenAt: number, now: number): boolean {
  return at > seenAt && now - at < NEW_REPORT_MS;
}
