/**
 * Stable sidebar ordering for the PROJECTS session tree.
 *
 * Main sorts sessions by updatedAt (desc), so a running turn would bump a
 * row to the top on every stream update and rows would jump mid-turn. Sort
 * keys below freeze a running session at its previous position timestamp;
 * the fresh updatedAt is adopted only once the turn ends (status leaves
 * "running"), re-sorting the list then. New sessions (no previous key)
 * adopt their current updatedAt immediately so they appear at the top.
 */
export type SortableSession = {
  id: string;
  updatedAt: number;
  status?: string;
};

export function computeSessionSortKeys(
  sessions: readonly SortableSession[],
  previous: ReadonlyMap<string, number>,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const session of sessions) {
    const frozen = previous.get(session.id);
    next.set(
      session.id,
      session.status === "running" && frozen !== undefined
        ? frozen
        : session.updatedAt,
    );
  }
  return next;
}

/** Sort in place, newest key first. Stable for equal keys (input order). */
export function sortSessionsByKeys<T extends SortableSession>(
  sessions: T[],
  keys: ReadonlyMap<string, number>,
): T[] {
  return sessions.sort(
    (a, b) => (keys.get(b.id) ?? 0) - (keys.get(a.id) ?? 0),
  );
}
