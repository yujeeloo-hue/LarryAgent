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

export function sortSessionsByKeys<T extends SortableSession>(
  sessions: T[],
  keys: ReadonlyMap<string, number>,
): T[] {
  return sessions.sort(
    (a, b) => (keys.get(b.id) ?? 0) - (keys.get(a.id) ?? 0),
  );
}
