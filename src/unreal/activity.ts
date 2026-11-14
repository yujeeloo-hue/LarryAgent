/** Mutual exclusion across windows and across Run / Debug, including startup. */
const activities = new Map<string, symbol>();
export function claimUnrealActivity(workspace: string): (() => void) | null {
  const key = workspace.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  if (activities.has(key)) return null;
  const token = Symbol(); activities.set(key, token);
  return () => { if (activities.get(key) === token) activities.delete(key); };
}
