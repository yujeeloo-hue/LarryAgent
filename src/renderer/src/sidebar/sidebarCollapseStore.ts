/** Persisted per-workspace collapse state for the sidebar Projects section. */

const WORKSPACES_KEY = "jellybot.sidebar.collapsedWorkspaces";

/** Only collapsed ids are stored, so unknown / new workspaces default to expanded. */
export function readCollapsedWorkspaceIds(): Set<string> {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function writeCollapsedWorkspaceIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore quota / private mode
  }
}
