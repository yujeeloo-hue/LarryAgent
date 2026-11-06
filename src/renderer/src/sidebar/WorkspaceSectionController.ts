import type {
  SessionListItem,
  WorkspaceListItem,
} from "../navigation/types.js";
import {
  readCollapsedWorkspaceIds,
  writeCollapsedWorkspaceIds,
} from "./sidebarCollapseStore.js";
import {
  computeSessionSortKeys,
  sortSessionsByKeys,
} from "./sessionSortKeys.js";
import {
  WorkspaceSectionView,
  type WorkspaceSectionRenderState,
} from "./WorkspaceSectionView.js";

/**
 * Work Space sidebar section controller — groups agent sessions by workspace.
 */
export class WorkspaceSectionController {
  private workspaces: WorkspaceListItem[] = [];
  /** All unarchived agent sessions in the tree (pre-filter). */
  private agentSessions: SessionListItem[] = [];
  private sessions: SessionListItem[] = [];
  private focusedWorkspaceId: string | null = null;
  private focusedSessionId: string | null = null;
  private unreadSessionIds = new Set<string>();
  private collapsedWorkspaceIds = readCollapsedWorkspaceIds();
  /** Frozen sort keys — running sessions keep their position mid-turn. */
  private sessionSortKeys = new Map<string, number>();
  private selectSessionHandler: ((sessionId: string) => void) | undefined;
  private archiveSessionHandler: ((sessionId: string) => void) | undefined;
  private deleteSessionHandler: ((sessionId: string) => void) | undefined;
  private handoverSessionHandler: ((sessionId: string) => void) | undefined;
  private takeBackSessionHandler: ((sessionId: string) => void) | undefined;
  private cocoUnavailable = false;
  private createWorkspaceHandler: (() => void) | undefined;
  private openArchivedHandler: (() => void) | undefined;
  private openSearchHandler: (() => void) | undefined;
  private newSessionHandler: ((workspaceId: string) => void) | undefined;
  private renameWorkspaceHandler:
    | ((
        workspaceId: string,
        currentName: string,
        currentPath: string,
      ) => void)
    | undefined;
  private archiveWorkspaceHandler: ((workspaceId: string) => void) | undefined;
  private deleteWorkspaceHandler: ((workspaceId: string) => void) | undefined;

  constructor(private readonly view: WorkspaceSectionView) {
    this.view.onSessionSelect((id) => this.selectSessionHandler?.(id));
    this.view.onSessionArchiveClick((id) => this.archiveSessionHandler?.(id));
    this.view.onSessionDeleteClick((id) => this.deleteSessionHandler?.(id));
    this.view.onSessionCocoHandover((id) => this.handoverSessionHandler?.(id));
    this.view.onSessionCocoTakeBack((id) => this.takeBackSessionHandler?.(id));
    this.view.onCreateWorkspaceClick(() => this.createWorkspaceHandler?.());
    this.view.onArchivedProjectsClick(() => this.openArchivedHandler?.());
    this.view.onSearchClick(() => this.openSearchHandler?.());
    this.view.onNewSessionClick((id) => this.newSessionHandler?.(id));
    this.view.onRenameWorkspaceClick((id, name, path) =>
      this.renameWorkspaceHandler?.(id, name, path),
    );
    this.view.onArchiveWorkspaceClick((id) => this.archiveWorkspaceHandler?.(id));
    this.view.onDeleteWorkspaceClick((id) => this.deleteWorkspaceHandler?.(id));
    this.view.onWorkspaceToggle((id, collapsed) => {
      if (collapsed) {
        this.collapsedWorkspaceIds.add(id);
      } else {
        this.collapsedWorkspaceIds.delete(id);
      }
      writeCollapsedWorkspaceIds(this.collapsedWorkspaceIds);
      this.render();
    });
    this.render();
  }

  mount(): HTMLElement {
    return this.view.root;
  }

  /** Anchor for the new-workspace template dropdown (the header `+`). */
  getAddWorkspaceButton(): HTMLButtonElement {
    return this.view.getAddWorkspaceButton();
  }

  setState(input: {
    workspaces: readonly WorkspaceListItem[];
    sessions: readonly SessionListItem[];
    focusedWorkspaceId: string | null;
    focusedSessionId: string | null;
    unreadSessionIds?: ReadonlySet<string>;
  }): void {
    this.workspaces = [...input.workspaces];
    // PROJECTS tree shows only unarchived agent sessions; archived ones live
    // in the Archived view. Unread ids of archived sessions simply never match.
    const agentSessions = input.sessions.filter(
      (s) => (s.type ?? "agent") === "agent" && !s.archived,
    );
    this.agentSessions = agentSessions;
    // Re-sort only on turn boundaries: a running session keeps its frozen
    // key so rows do not jump while a turn streams.
    this.applySessionSort();
    this.focusedSessionId = input.focusedSessionId;
    this.focusedWorkspaceId =
      input.focusedWorkspaceId ??
      this.resolveWorkspaceId(input.focusedSessionId);
    if (input.unreadSessionIds) {
      this.unreadSessionIds = new Set(input.unreadSessionIds);
    }
    this.pruneCollapsedWorkspaceIds();
    this.render();
  }

  /**
   * (Re)compute stable sort keys for the agent sessions. Loop/CoCo sessions
   * are always shown — the former "Hide Loops" header filter was removed
   * (user decision 2026-10-30: unnecessary feature).
   */
  private applySessionSort(): void {
    this.sessions = this.agentSessions;
    this.sessionSortKeys = computeSessionSortKeys(
      this.sessions,
      this.sessionSortKeys,
    );
    sortSessionsByKeys(this.sessions, this.sessionSortKeys);
  }

  /** Drop ids of deleted workspaces so the stored set cannot grow forever. */
  private pruneCollapsedWorkspaceIds(): void {    if (this.workspaces.length === 0) return;
    const known = new Set(this.workspaces.map((w) => w.id));
    let changed = false;
    for (const id of this.collapsedWorkspaceIds) {
      if (!known.has(id)) {
        this.collapsedWorkspaceIds.delete(id);
        changed = true;
      }
    }
    if (changed) writeCollapsedWorkspaceIds(this.collapsedWorkspaceIds);
  }

  setFocusedSessionId(sessionId: string | null): void {
    const workspaceId = this.resolveWorkspaceId(sessionId);
    if (
      this.focusedSessionId === sessionId &&
      this.focusedWorkspaceId === workspaceId
    ) {
      return;
    }
    this.focusedSessionId = sessionId;
    this.focusedWorkspaceId = workspaceId;
    this.render();
  }

  setUnreadSessionIds(ids: ReadonlySet<string>): void {
    this.unreadSessionIds = new Set(ids);
    this.render();
  }

  private resolveWorkspaceId(sessionId: string | null): string | null {
    if (!sessionId) return null;
    return this.sessions.find((s) => s.id === sessionId)?.workspaceId ?? null;
  }

  private render(): void {
    const sessionsByWorkspace = new Map<string, SessionListItem[]>();
    for (const ws of this.workspaces) {
      sessionsByWorkspace.set(ws.id, []);
    }
    for (const session of this.sessions) {
      const key = session.workspaceId ?? "";
      const list = sessionsByWorkspace.get(key);
      if (list) {
        list.push(session);
      } else if (key) {
        sessionsByWorkspace.set(key, [session]);
      }
    }

    const state: WorkspaceSectionRenderState = {
      workspaces: this.workspaces,
      sessionsByWorkspace,
      focusedWorkspaceId: this.focusedWorkspaceId,
      focusedSessionId: this.focusedSessionId,
      unreadSessionIds: this.unreadSessionIds,
      collapsedWorkspaceIds: this.collapsedWorkspaceIds,
      cocoUnavailable: this.cocoUnavailable,
    };
    this.view.render(state);
  }

  onSessionSelect(handler: (sessionId: string) => void): void {
    this.selectSessionHandler = handler;
  }

  onSessionArchive(handler: (sessionId: string) => void): void {
    this.archiveSessionHandler = handler;
  }

  onSessionDelete(handler: (sessionId: string) => void): void {
    this.deleteSessionHandler = handler;
  }

  onSessionCocoHandover(handler: (sessionId: string) => void): void {
    this.handoverSessionHandler = handler;
  }

  onSessionCocoTakeBack(handler: (sessionId: string) => void): void {
    this.takeBackSessionHandler = handler;
  }

  /** CoCo engine availability flips the hand-over entry on every session row. */
  setCocoUnavailable(unavailable: boolean): void {
    if (this.cocoUnavailable === unavailable) return;
    this.cocoUnavailable = unavailable;
    this.render();
  }

  onCreateWorkspace(handler: () => void): void {
    this.createWorkspaceHandler = handler;
  }

  onOpenArchived(handler: () => void): void {
    this.openArchivedHandler = handler;
  }

  onOpenSearch(handler: () => void): void {
    this.openSearchHandler = handler;
  }

  onNewSession(handler: (workspaceId: string) => void): void {
    this.newSessionHandler = handler;
  }

  onRenameWorkspace(
    handler: (
      workspaceId: string,
      currentName: string,
      currentPath: string,
    ) => void,
  ): void {
    this.renameWorkspaceHandler = handler;
  }

  onArchiveWorkspace(handler: (workspaceId: string) => void): void {
    this.archiveWorkspaceHandler = handler;
  }

  onDeleteWorkspace(handler: (workspaceId: string) => void): void {
    this.deleteWorkspaceHandler = handler;
  }

  setArchivedCount(count: number): void {
    this.view.setArchivedCount(count);
  }
}

export function createWorkspaceSection(): WorkspaceSectionController {
  return new WorkspaceSectionController(new WorkspaceSectionView());
}
