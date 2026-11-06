/**
 * Process-wide workspace list + active workspace id for renderer UI.
 * Refreshed on IPC workspace:changed and after local mutations.
 */

export type WorkspaceListEntry = {
  id: string;
  name: string;
  path: string;
};

export type ArchivedWorkspaceEntry = WorkspaceListEntry;

export type WorkspacesState = {
  workspaces: readonly WorkspaceListEntry[];
  archivedWorkspaces: readonly ArchivedWorkspaceEntry[];
  activeWorkspaceId: string | null;
};

let workspaces: WorkspaceListEntry[] = [];
let archivedWorkspaces: ArchivedWorkspaceEntry[] = [];
let activeWorkspaceId: string | null = null;

const listeners = new Set<(state: WorkspacesState) => void>();

function snapshot(): WorkspacesState {
  return { workspaces, archivedWorkspaces, activeWorkspaceId };
}

function notify(): void {
  const state = snapshot();
  for (const listener of listeners) {
    listener(state);
  }
}

export function getWorkspacesState(): WorkspacesState {
  return snapshot();
}

export async function refreshWorkspacesState(): Promise<void> {
  const bridge = window.jellybot;
  if (!bridge?.listWorkspaces || !bridge.getActiveWorkspaceId) return;

  try {
    const [list, archived, activeId] = await Promise.all([
      bridge.listWorkspaces(),
      bridge.listArchivedWorkspaces
        ? bridge.listArchivedWorkspaces()
        : Promise.resolve([]),
      bridge.getActiveWorkspaceId(),
    ]);
    workspaces = list.map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
    }));
    archivedWorkspaces = (archived ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
    }));
    activeWorkspaceId = activeId;
    notify();
  } catch (err) {
    console.error("[workspaceState] refresh failed", err);
  }
}

export function subscribeWorkspaces(
  listener: (state: WorkspacesState) => void,
): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

let unsubWorkspaceChanged: (() => void) | undefined;

/** Load once and listen for main-process workspace changes. */
export async function bootstrapWorkspacesState(): Promise<void> {
  await refreshWorkspacesState();
  const bridge = window.jellybot;
  if (!bridge?.onWorkspaceChanged || unsubWorkspaceChanged) return;
  unsubWorkspaceChanged = bridge.onWorkspaceChanged(() => {
    void refreshWorkspacesState();
  });
}
