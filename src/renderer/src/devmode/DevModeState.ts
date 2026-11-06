/**
 * Per-workspace Dev Mode memory (plan decision #3): the titlebar toggle
 * persists per workspace; opening a session in a remembered workspace
 * auto-enters Dev Mode. Convention: jellybot.* localStorage keys.
 */
const KEY_PREFIX = "jellybot.devmode.workspace.";

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
