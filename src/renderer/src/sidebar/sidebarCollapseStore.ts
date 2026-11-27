
const WORKSPACES_KEY = "jellybot.sidebar.collapsedWorkspaces";

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
  }
}
