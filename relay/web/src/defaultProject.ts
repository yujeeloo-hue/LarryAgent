import type { SessionSummary } from "./types.js";

export function pickDefaultSession(list: SessionSummary[], knownProjects?: readonly string[]): SessionSummary | null {
  const known = knownProjects ? new Set(knownProjects) : null;
  let best: SessionSummary | null = null;
  let bestKnown = false;
  for (const s of list) {
    if (s.archived) continue;
    const isKnown = !known || known.has(s.workspaceId);
    if (
      !best ||
      (isKnown && !bestKnown) ||
      (isKnown === bestKnown && s.updatedAt > best.updatedAt)
    ) {
      best = s;
      bestKnown = isKnown;
    }
  }
  return best;
}

export function pickDefaultProject(projects: string[], list: SessionSummary[]): string | null {
  if (!projects.length) return null;
  const running = new Set<string>();
  const lastRunAt = new Map<string, number>();
  for (const s of list) {
    if (s.status === "running") running.add(s.workspaceId);
    if ((lastRunAt.get(s.workspaceId) ?? 0) < s.updatedAt) lastRunAt.set(s.workspaceId, s.updatedAt);
  }
  let recent: string | null = null;
  let recentAt = -1;
  for (const p of projects) {
    if (running.has(p)) return p;
    const at = lastRunAt.get(p) ?? 0;
    if (at > recentAt) {
      recent = p;
      recentAt = at;
    }
  }
  return recent ?? projects[0] ?? null;
}
