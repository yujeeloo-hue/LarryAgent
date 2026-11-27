import { AGENT_NAV_ITEMS } from "../navigation/types.js";
import type {
  AgentNavId,
  SessionListItem,
  WorkspaceListItem,
} from "../navigation/types.js";
import { AgentNavController } from "./AgentNavController.js";
import { AgentNavView } from "./AgentNavView.js";
import {
  createArchivedProjectsSection,
  type ArchivedProjectsController,
} from "./ArchivedProjectsController.js";
import type { ArchivedProjectItem } from "./ArchivedProjectsView.js";
import { createWorkspaceSection } from "./WorkspaceSectionController.js";
import type { WorkspaceSectionController } from "./WorkspaceSectionController.js";
import type { SidebarView } from "./SidebarView.js";

export class SidebarController {
  private readonly agentNav: AgentNavController;
  private readonly workspaces: WorkspaceSectionController;
  private readonly archived: ArchivedProjectsController;

  constructor(
    private readonly view: SidebarView,
    navigate: (update: () => void, shouldAnimate: () => boolean) => void,
  ) {
    this.agentNav = new AgentNavController(new AgentNavView(AGENT_NAV_ITEMS), navigate);
    this.workspaces = createWorkspaceSection();
    this.archived = createArchivedProjectsSection();

  }

  mount(): HTMLElement {
    this.view.agentSlot.replaceChildren(this.agentNav.mount());
    this.view.sessionsSlot.replaceChildren(this.workspaces.mount());
    this.view.archivedSlot.replaceChildren(this.archived.mount());
    return this.view.root;
  }

  getActiveNav(): AgentNavId | null {
    return this.agentNav.getActive();
  }

  clearNavSelection(): void {
    this.agentNav.clearSelection();
  }

  selectNav(id: AgentNavId): void {
    this.agentNav.select(id);
  }

  onNavChange(handler: (id: AgentNavId) => void): void {
    this.agentNav.onSelectionChange(handler);
  }

  onSessionSelect(handler: (sessionId: string) => void): void {
    this.workspaces.onSessionSelect(handler);
  }

  onSessionArchive(handler: (sessionId: string) => void): void {
    this.workspaces.onSessionArchive(handler);
  }

  onSessionDelete(handler: (sessionId: string) => void): void {
    this.workspaces.onSessionDelete(handler);
  }

  onSessionCocoHandover(handler: (sessionId: string) => void): void {
    this.workspaces.onSessionCocoHandover(handler);
  }

  onSessionCocoTakeBack(handler: (sessionId: string) => void): void {
    this.workspaces.onSessionCocoTakeBack(handler);
  }

  onCreateWorkspace(handler: () => void): void {
    this.workspaces.onCreateWorkspace(handler);
  }

  getAddWorkspaceButton(): HTMLButtonElement {
    return this.workspaces.getAddWorkspaceButton();
  }

  onNewSessionInWorkspace(handler: (workspaceId: string) => void): void {
    this.workspaces.onNewSession(handler);
  }

  onArchiveWorkspace(handler: (workspaceId: string) => void): void {
    this.workspaces.onArchiveWorkspace(handler);
  }

  onDeleteWorkspace(handler: (workspaceId: string) => void): void {
    this.workspaces.onDeleteWorkspace(handler);
  }

  onOpenArchivedProjects(handler: () => void): void {
    this.workspaces.onOpenArchived(handler);
  }

  onOpenSearch(handler: () => void): void {
    this.workspaces.onOpenSearch(handler);
  }

  onUnarchiveWorkspace(handler: (workspaceId: string) => void): void {
    this.archived.onUnarchive(handler);
  }

  onArchivedDeleteWorkspace(handler: (workspaceId: string) => void): void {
    this.archived.onDelete(handler);
  }

  onArchivedSessionUnarchive(handler: (sessionId: string) => void): void {
    this.archived.onSessionUnarchive(handler);
  }

  onArchivedSessionDelete(handler: (sessionId: string) => void): void {
    this.archived.onSessionDelete(handler);
  }

  onArchivedBack(handler: () => void): void {
    this.archived.onBack(handler);
  }

  setShowArchived(showArchived: boolean): void {
    this.view.sessionsSlot.hidden = showArchived;
    this.view.archivedSlot.hidden = !showArchived;
  }

  setArchivedCount(count: number): void {
    this.workspaces.setArchivedCount(count);
  }

  setArchivedItems(items: readonly ArchivedProjectItem[]): void {
    this.archived.setItems(items);
  }

  onRenameWorkspace(
    handler: (
      workspaceId: string,
      currentName: string,
      currentPath: string,
    ) => void,
  ): void {
    this.workspaces.onRenameWorkspace(handler);
  }

  setWorkspaceState(input: {
    workspaces: readonly WorkspaceListItem[];
    sessions: readonly SessionListItem[];
    focusedWorkspaceId: string | null;
    focusedSessionId: string | null;
    unreadSessionIds?: ReadonlySet<string>;
  }): void {
    this.workspaces.setState(input);
  }

  setFocusedSessionId(sessionId: string | null): void {
    this.workspaces.setFocusedSessionId(sessionId);
  }

  setUnreadSessionIds(ids: ReadonlySet<string>): void {
    this.workspaces.setUnreadSessionIds(ids);
  }

  setCocoUnavailable(unavailable: boolean): void {
    this.workspaces.setCocoUnavailable(unavailable);
  }
}
