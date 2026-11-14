import type { SessionSummary } from "./types.js";

/**
 * Default session to open after selecting a device: the most recently
 * interacted one (max `updatedAt`, any status — a running session streams
 * and stays fresh on its own, no explicit boost needed). Sessions whose
 * project is still in the device registry (`knownProjects`) outrank orphan
 * projects whose workspace was deleted/never migrated — opening into a
 * removed project reads as a broken default (raw id in the filter). Pass
 * the device's current project aggregate as `knownProjects` (same source
 * the sidebar uses); undefined = no registry info, treat all as known.
 * Archived sessions never open; ties keep the earlier entry (the caller's
 * list is sorted newest-first). null only when there is nothing to open;
 * its `workspaceId` is also the default project filter — the project is
 * derived from the session, not picked separately.
 */
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

/**
 * Default project filter rule for the session column (pure; the caller
 * supplies the device's project aggregate). Used only as the fallback when
 * the device has projects but no openable session.
 *
 * Priority: a project with a session currently running wins; otherwise the
 * project that most recently had session activity (max `updatedAt`) — the
 * user almost always wants to continue where things last happened; ties and
 * projects without live sessions fall back to the first project (default
 * alphabetical order). Workspace-id keyed.
 */
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
