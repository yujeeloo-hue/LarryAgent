/**
 * Per-workspace Dev Mode memory (plan decision #3): the titlebar toggle
 * persists per workspace; opening a session in a remembered workspace
 * auto-enters Dev Mode. Convention: jellybot.* localStorage keys.
 */
const KEY_PREFIX = "jellybot.devmode.workspace.";
const TASK_KEY_PREFIX = "jellybot.devmode.lastTask.";

/** Undefined = unvisited; null = the workspace's New Task draft. */
export function readLastDevModeTask(workspaceId: string): string | null | undefined {
  try {
    const raw = localStorage.getItem(`${TASK_KEY_PREFIX}${workspaceId}`);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return value === null || typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastDevModeTask(workspaceId: string, taskId: string | null): void {
  try {
    localStorage.setItem(`${TASK_KEY_PREFIX}${workspaceId}`, JSON.stringify(taskId));
  } catch {
    // Storage may be unavailable; navigation still works for this entry.
  }
}

export function readDevModeMemory(
  workspaceId: string | null | undefined,
): boolean {
  if (!workspaceId) return false;
  try {
    return localStorage.getItem(`${KEY_PREFIX}${workspaceId}`) === "1";
  } catch {
    return false;
  }
}

export function writeDevModeMemory(
  workspaceId: string | null | undefined,
  enabled: boolean,
): void {
  if (!workspaceId) return;
  try {
    if (enabled) localStorage.setItem(`${KEY_PREFIX}${workspaceId}`, "1");
    else localStorage.removeItem(`${KEY_PREFIX}${workspaceId}`);
  } catch {
    // ignore quota / private mode
  }
}
