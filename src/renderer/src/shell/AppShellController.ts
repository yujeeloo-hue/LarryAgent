import type {
  AgentNavId,
  SessionListItem,
} from "../navigation/types.js";
import { DevToolsController } from "../dev-tools/DevToolsController.js";
import { ConversationController } from "../screens/conversation/ConversationController.js";
import { ConversationView } from "../screens/conversation/ConversationView.js";
import type { PendingAttachment } from "../ui/taskComposer/bindComposerAttachments.js";
import { CocoController } from "../screens/coco/CocoController.js";
import { cocoState } from "../state/cocoState.js";
import { renderCocoActivity } from "../state/cocoActivity.js";
import { NewTaskController } from "../screens/new-task/NewTaskController.js";
import { NewTaskView } from "../screens/new-task/NewTaskView.js";
import { refreshWorkspacesState, getWorkspacesState } from "../state/workspaceState.js";
import { SearchController } from "../screens/search/SearchController.js";
import { SearchView } from "../screens/search/SearchView.js";
import { SettingController } from "../screens/setting/SettingController.js";
import { SettingView } from "../screens/setting/SettingView.js";
import { ToolsController } from "../screens/tools/ToolsController.js";
import { ToolsView } from "../screens/tools/ToolsView.js";
import { SkillsController } from "../screens/skills/SkillsController.js";
import { SkillsView } from "../screens/skills/SkillsView.js";
import { GraphsController } from "../screens/graphs/GraphsController.js";
import { GraphsView } from "../screens/graphs/GraphsView.js";
import { GraphEditorController } from "../screens/graph-editor/GraphEditorController.js";
import { GraphEditorView } from "../screens/graph-editor/GraphEditorView.js";
import { SidebarController } from "../sidebar/SidebarController.js";
import { SidebarView } from "../sidebar/SidebarView.js";
import { TitleBarController } from "../titlebar/TitleBarController.js";
import { TitleBarView } from "../titlebar/TitleBarView.js";
import { showEditWorkspaceDialog } from "../ui/EditWorkspaceDialogView.js";
import { AppNotificationCenter } from "../ui/appNotificationCenter.js";
import { openWorkspaceTemplateMenu } from "../ui/newWorkspaceFlow.js";
import { createRafCoalescer } from "../ui/rafCoalesce.js";
import type { AppShellView } from "./AppShellView.js";
import { DrawerResizeController } from "./DrawerResizeController.js";
import { SidebarResizeController } from "./SidebarResizeController.js";
import { DevModeController } from "../devmode/DevModeController.js";
import {
  readDevModeMemory,
  writeDevModeMemory,
} from "../devmode/DevModeState.js";

type ScreenController = {
  mount(): HTMLElement;
  destroy(): void;
};

/**
 * What the main slot showed before Settings opened — the title-bar gear
 * toggles back to it. Dev Mode is captured as such because entering
 * Settings tears the workbench down; leaving re-enters it.
 */
type SettingsResumeTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "nav"; id: AgentNavId }
  | { kind: "graph-editor"; graphId: string }
  | { kind: "dev-mode"; sessionId: string | null };

/**
 * Shell orchestration: title bar + sidebar + main screen swap + Detail drawer.
 * Session list / conversation open via main-process agent IPC.
 */
export class AppShellController {
  private readonly titleBar: TitleBarController;
  private readonly sidebar: SidebarController;
  private readonly devTools: DevToolsController;
  private readonly sidebarResize: SidebarResizeController;
  private readonly drawerResize: DrawerResizeController;
  private activeScreen: ScreenController | undefined;
  /** Restore target for the Settings gear toggle (captured on entry). */
  private settingsResume: SettingsResumeTarget | undefined;
  /** Dev Mode workbench (plan: dev-mode-v1); non-null while active. */
  private devMode: DevModeController | null = null;
  /**
   * Workspace Dev Mode is currently attached to. The workbench re-roots
   * when a session of another project is opened (setSession → applyWorkspace),
   * so exit must clear the memory of THIS workspace, not whatever the last
   * enter wrote — a stale "1" on the old workspace would force Dev Mode
   * back on when its session is reopened (the forced-Dev-Mode bug).
   */
  private devModeWorkspaceId: string | null = null;
  private unsubSessionUpdated: (() => void) | undefined;
  private unsubCocoActivity: (() => void) | undefined;
  private unsubCocoChanged: (() => void) | undefined;
  private unsubSessionDeleted: (() => void) | undefined;
  private unsubWorkspaceChanged: (() => void) | undefined;
  private unsubAgentStream: (() => void) | undefined;
  private unsubUserAsk: (() => void) | undefined;
  private unsubMenubarAction: (() => void) | undefined;
  private unsubNotifyActivate: (() => void) | undefined;
  private notifications: AppNotificationCenter | undefined;
  private agentSessionItems: SessionListItem[] = [];
  private activeSessionId: string | null = null;
  /** Sidebar shows the Archived Projects list instead of PROJECTS. */
  private showArchived = false;
  /** Sessions needing attention while not open (turn done / ask_user). */
  private readonly unreadSessionIds = new Set<string>();
  private readonly sidebarRefreshCoalesce = createRafCoalescer(
    () => this.refreshSidebar(),
    "sidebar.refresh",
  );

  constructor(private readonly view: AppShellView) {
    this.titleBar = new TitleBarController(new TitleBarView());
    this.sidebar = new SidebarController(new SidebarView());
    this.devTools = new DevToolsController();
    this.sidebarResize = new SidebarResizeController(view);
    this.drawerResize = new DrawerResizeController(view);
  }

  mount(host: HTMLElement): void {
    this.view.titleBarSlot.replaceChildren(this.titleBar.mount());
    this.view.sidebarSlot.replaceChildren(this.sidebar.mount());
    this.view.drawerContent.replaceChildren(this.devTools.mount());
    this.sidebarResize.mount();
    this.drawerResize.mount();
    this.showNavScreen(this.sidebar.getActiveNav() ?? "new-task");

    this.titleBar.onLogsToggle((open) => {
      this.setDevToolsOpen(open);
    });
    this.titleBar.onSettingsClick(() => {
      this.toggleSettingScreen();
    });
    this.titleBar.onDevModeToggle(() => {
      this.toggleDevMode();
    });
    // Windows self-drawn caption buttons (no-op on macOS).
    const windowBridge = window.jellybot;
    if (windowBridge) {
      this.titleBar.attachWindowControls({
        platform: windowBridge.platform,
        controls: windowBridge.windowControls,
        onMaximizeChanged: windowBridge.onWindowMaximizeChanged,
      });
      this.titleBar.attachRemoteSignal(windowBridge);
    }
    this.titleBar.onRemoteConsoleOpen(() => {
      void this.openRemoteConsole();
    });
    this.devTools.onClose(() => {
      this.titleBar.setLogsOpen(false);
      this.setDevToolsOpen(false);
    });
    this.devTools.onTimelinePanelHeightToggle(() => {
      // Timeline toolbar ⇕ button: cycle the drawer between 218 / 405 px.
      this.drawerResize.toggleHeightPx(218, 405);
    });
    this.devTools.onTimelineBarSelect(() => {
      // Bar detail cards need room: expand to 405 px when the drawer is shorter.
      this.drawerResize.ensureHeightPx(405);
    });

    this.sidebar.onNavChange((id) => {
      this.titleBar.setSettingsActive(false);
      this.showNavScreen(id);
    });
    this.sidebar.onSessionSelect((sessionId) => {
      this.openSession(sessionId);
    });
    this.sidebar.onSessionArchive((sessionId) => {
      void this.archiveSessionFlow(sessionId);
    });
    this.sidebar.onSessionDelete((sessionId) => {
      void this.deleteSession(sessionId);
    });
    this.sidebar.onSessionCocoHandover((sessionId) => {
      void this.handoverSessionToCoco(sessionId);
    });
    this.sidebar.onSessionCocoTakeBack((sessionId) => {
      void this.takeBackSessionFromCoco(sessionId);
    });
    this.sidebar.onCreateWorkspace(() => {
      this.createWorkspaceFlow();
    });
    this.sidebar.onNewSessionInWorkspace((workspaceId) => {
      void this.newSessionInWorkspace(workspaceId);
    });
    this.sidebar.onArchiveWorkspace((workspaceId) => {
      void this.archiveWorkspaceFlow(workspaceId);
    });
    this.sidebar.onDeleteWorkspace((workspaceId) => {
      void this.deleteWorkspaceFlow(workspaceId);
    });
    this.sidebar.onOpenArchivedProjects(() => {
      this.setShowArchived(true);
    });
    this.sidebar.onOpenSearch(() => {
      // selectNav drives the existing nav-change chain (clears Setting
      // highlight, swaps to the Search screen); no nav row highlights.
      this.sidebar.selectNav("search");
    });
    this.sidebar.onArchivedBack(() => {
      this.setShowArchived(false);
    });
    this.sidebar.onUnarchiveWorkspace((workspaceId) => {
      void this.unarchiveWorkspaceFlow(workspaceId);
    });
    this.sidebar.onArchivedDeleteWorkspace((workspaceId) => {
      void this.deleteWorkspaceFlow(workspaceId);
    });
    this.sidebar.onArchivedSessionUnarchive((sessionId) => {
      void this.unarchiveSessionFlow(sessionId);
    });
    this.sidebar.onArchivedSessionDelete((sessionId) => {
      void this.deleteSession(sessionId);
    });
    this.sidebar.onRenameWorkspace((workspaceId, currentName, currentPath) => {
      void this.renameWorkspaceFlow(workspaceId, currentName, currentPath);
    });

    const bridge = window.jellybot;
    if (bridge) {
      this.unsubCocoActivity?.();
      this.unsubCocoActivity = bridge.onCocoActivity?.(renderCocoActivity);
      void bridge.cocoActivity?.().then(renderCocoActivity, () => renderCocoActivity(undefined));
      // Hand-over entry visibility follows CoCo engine availability.
      this.unsubCocoChanged?.();
      this.unsubCocoChanged = bridge.onCocoChanged?.(() => void this.refreshCocoAvailability());
      void this.refreshCocoAvailability();
      void this.refreshSidebar();
      this.unsubSessionUpdated = bridge.onSessionUpdated((summary) => {
        if (["coco", "coco_chat"].includes(summary.source ?? "")) cocoState.refreshIfObserved();
        this.sidebarRefreshCoalesce.schedule();
        this.devTools.notifySessionUpdated(summary.id);
      });
      this.unsubSessionDeleted = bridge.onSessionDeleted?.((payload) => {
        if (this.unreadSessionIds.delete(payload.id)) {
          this.sidebar.setUnreadSessionIds(this.unreadSessionIds);
        }
        this.sidebarRefreshCoalesce.schedule();
      });
      this.unsubWorkspaceChanged = bridge.onWorkspaceChanged?.(() => {
        this.sidebarRefreshCoalesce.schedule();
      });
      this.unsubAgentStream = bridge.onAgentStream((payload) => {
        if (payload.event.type !== "done") return;
        this.markSessionUnreadIfBackground(payload.sessionId);
      });
      this.unsubUserAsk = bridge.onUserAsk?.((payload) => {
        this.markSessionUnreadIfBackground(payload.sessionId);
      });
      // Menu bar brand menu (macOS): focus arrives via the main process;
      // navigation rides the existing chains — selectNav for nav screens,
      // the settings path clears the nav highlight itself.
      this.unsubMenubarAction = bridge.onMenubarAction?.(({ action }) => {
        if (action === "settings") {
          this.showSettingScreen();
          return;
        }
        this.sidebar.selectNav(action);
      });
      // Self-owned notifications: bell inbox + in-app toast overlay
      // (background popups are main-process windows; every click surface
      // marks read and jumps to the notification's session).
      this.notifications = new AppNotificationCenter({
        onOpenSession: (sessionId) => this.openSession(sessionId),
        onUnreadCount: (count) => this.titleBar.setBellUnread(count),
      });
      this.notifications.attachBell(this.titleBar.bellButton);
      this.notifications.start(bridge);
      this.unsubNotifyActivate = bridge.onNotifyActivate?.((payload) => {
        if (payload.sessionId) this.openSession(payload.sessionId);
      });
    }

    host.replaceChildren(this.view.root);
  }

  /**
   * Title-bar remote indicator click: open the relay web console in the
   * system browser (shell.openExternal hands off to the default browser on
   * macOS and Windows alike). A blank server URL is a no-op — the indicator
   * is only visible with a working relay connection anyway.
   */
  private async openRemoteConsole(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge) return;
    try {
      const { config } = await bridge.getRemoteConfig();
      const base = config.serverUrl.trim().replace(/\/+$/, "");
      if (!base) return;
      await bridge.openExternal(`${base}/relay/`);
    } catch (err) {
      console.error("[shell] open remote console failed", err);
    }
  }

  private setDevToolsOpen(open: boolean): void {
    this.view.setDrawerOpen(open);
    this.devTools.setOpen(open);
  }

  /** Swap the sidebar between PROJECTS and the Archived Projects list. */
  private setShowArchived(show: boolean): void {
    if (this.showArchived === show) return;
    this.showArchived = show;
    this.sidebar.setShowArchived(show);
    void this.refreshSidebar();
  }

  private async unarchiveWorkspaceFlow(workspaceId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.setWorkspaceArchived) return;
    try {
      await bridge.setWorkspaceArchived({
        workspaceId,
        archived: false,
      });
      await refreshWorkspacesState();
      await this.refreshSidebar();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (bridge.alertDialog) {
        await bridge.alertDialog({
          message,
          type: "warning",
          title: "Unarchive",
        });
      } else {
        window.alert(message);
      }
    }
  }

  /** CoCo engine reachable ⇒ the sidebar shows the hand-over entry. */
  private async refreshCocoAvailability(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.cocoSnapshot) return;
    try {
      const snapshot = await bridge.cocoSnapshot();
      const unavailable =
        !snapshot.settings.enabled ||
        snapshot.state === "blocked" ||
        Boolean(snapshot.error);
      this.sidebar.setCocoUnavailable(unavailable);
    } catch {
      // Engine mid-boot / quitting: keep the last known availability.
    }
  }

  /** Sidebar hand-over click: mark the session CoCo-managed and wake CoCo with it. */
  private async handoverSessionToCoco(sessionId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.cocoHandoverSession) return;
    let result: { ok: boolean; error?: string };
    try {
      result = await bridge.cocoHandoverSession(sessionId);
    } catch {
      return; // Engine mid-boot; the availability subscription hides the entry.
    }
    if (result.ok) return; // The row converges via session:updated (source flip).
    const message = result.error ?? "CoCo is not available right now.";
    if (bridge.alertDialog) {
      await bridge.alertDialog({ message, type: "warning", title: "Hand over to CoCo" });
    } else {
      window.alert(message);
    }
  }

  /** Sidebar take-back click: the session returns to the user (works with CoCo off). */
  private async takeBackSessionFromCoco(sessionId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.cocoTakeBackSession) return;
    let result: { ok: boolean; error?: string };
    try {
      result = await bridge.cocoTakeBackSession(sessionId);
    } catch {
      return; // Store-level op; a transport failure leaves state untouched.
    }
    if (result.ok) return; // The row converges via session:updated (source flip).
    const message = result.error ?? "Could not take the session back.";
    if (bridge.alertDialog) {
      await bridge.alertDialog({ message, type: "warning", title: "Take back from CoCo" });
    } else {
      window.alert(message);
    }
  }

  private async refreshSidebar(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge) return;
    const [sessions, workspaces, archived] = await Promise.all([
      bridge.listSessions(),
      bridge.listWorkspaces(),
      bridge.listArchivedWorkspaces
        ? bridge.listArchivedWorkspaces()
        : Promise.resolve([]),
    ]);
    const items: SessionListItem[] = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      status: s.status,
      progressText: s.progressText,
      type: s.type,
      messageCount: s.messageCount,
      workspaceId: s.workspaceId,
      archived: s.archived,
      archivedAt: s.archivedAt ?? null,
      ...(s.source ? { source: s.source } : {}),
    }));
    this.agentSessionItems = items.filter((i) => (i.type ?? "agent") === "agent");
    this.sidebar.setWorkspaceState({
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        origin: w.origin,
        updatedAt: w.updatedAt,
      })),
      sessions: items,
      focusedWorkspaceId: this.getFocusedWorkspaceId(),
      focusedSessionId: this.activeSessionId,
      unreadSessionIds: this.unreadSessionIds,
    });

    // Dev Mode: refresh the chat header title + session dropdown.
    this.devMode?.notifySessionsChanged();

    // Archived view tree: group archived sessions under their workspaces.
    const archivedSessionsByWorkspace = new Map<string, SessionListItem[]>();
    for (const item of this.agentSessionItems) {
      if (!item.archived) continue;
      const key = item.workspaceId ?? "";
      if (!key) continue;
      const list = archivedSessionsByWorkspace.get(key) ?? [];
      list.push(item);
      archivedSessionsByWorkspace.set(key, list);
    }
    this.sidebar.setArchivedCount(archived.length);
    this.sidebar.setArchivedItems(
      archived.map((w) => {
        const groupSessions = (
          archivedSessionsByWorkspace.get(w.id) ?? []
        ).slice().sort((a, b) => b.updatedAt - a.updatedAt);
        const maxArchivedAt = groupSessions.reduce<number | null>(
          (acc, s) =>
            s.archivedAt && (!acc || s.archivedAt > acc) ? s.archivedAt : acc,
          null,
        );
        return {
          id: w.id,
          name: w.name,
          path: w.path,
          archivedAt: maxArchivedAt,
          hasActiveSessions: this.agentSessionItems.some(
            (s) => s.workspaceId === w.id && !s.archived,
          ),
          sessions: groupSessions.map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            archivedAt: s.archivedAt ?? null,
          })),
        };
      }),
    );
  }

  private getFocusedWorkspaceId(): string | null {
    if (!this.activeSessionId) return null;
    return (
      this.agentSessionItems.find((s) => s.id === this.activeSessionId)
        ?.workspaceId ?? null
    );
  }

  private syncFocusedHighlight(): void {
    this.sidebar.setFocusedSessionId(this.activeSessionId);
  }

  private createWorkspaceFlow(): void {
    openWorkspaceTemplateMenu(this.sidebar.getAddWorkspaceButton(), {
      onCreated: () => {
        void this.refreshSidebar();
      },
    });
  }

  private async newSessionInWorkspace(workspaceId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.setActiveWorkspaceId) return;
    try {
      await bridge.setActiveWorkspaceId(workspaceId);
      await refreshWorkspacesState();
      await this.refreshSidebar();
      this.sidebar.selectNav("new-task");
      this.showNavScreen("new-task");
    } catch (err) {
      console.error("[shell] set active workspace failed", err);
    }
  }

  private async renameWorkspaceFlow(
    workspaceId: string,
    currentName: string,
    currentPath: string,
  ): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.updateWorkspace) return;

    const dialogOpts: Parameters<typeof showEditWorkspaceDialog>[0] = {
      title: "Edit workspace",
      name: currentName,
      path: currentPath,
      confirmLabel: "Save",
    };
    if (bridge.pickWorkspaceFolder) {
      dialogOpts.onPickFolder = () => bridge.pickWorkspaceFolder();
    }
    const result = await showEditWorkspaceDialog(dialogOpts);
    if (result === null) return;

    const nextName = result.name.trim();
    const nextPath = result.path.trim();
    if (!nextName) {
      if (bridge.alertDialog) {
        await bridge.alertDialog({
          message: "Workspace name is required",
          type: "error",
          title: "Error",
        });
      } else {
        window.alert("Workspace name is required");
      }
      return;
    }
    if (!nextPath) {
      if (bridge.alertDialog) {
        await bridge.alertDialog({
          message: "Workspace folder is required",
          type: "error",
          title: "Error",
        });
      } else {
        window.alert("Workspace folder is required");
      }
      return;
    }
    if (
      nextName === currentName.trim() &&
      nextPath === currentPath.trim()
    ) {
      return;
    }

    try {
      await bridge.updateWorkspace({
        id: workspaceId,
        name: nextName,
        path: nextPath,
      });
      await refreshWorkspacesState();
      await this.refreshSidebar();
      // Remount open conversation so tools/Changes pick up the new path.
      if (
        this.activeSessionId &&
        this.activeScreen instanceof ConversationController
      ) {
        this.openSession(this.activeSessionId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (bridge.alertDialog) {
        await bridge.alertDialog({ message, type: "error", title: "Error" });
      } else {
        window.alert(message);
      }
    }
  }

  private async deleteWorkspaceFlow(workspaceId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.deleteWorkspace) return;

    const workspaceSessions = this.agentSessionItems.filter(
      (s) => s.workspaceId === workspaceId,
    );
    const hasActiveSessions = workspaceSessions.some((s) => !s.archived);
    const archivedSessionIds = new Set(
      workspaceSessions.filter((s) => s.archived).map((s) => s.id),
    );

    const ok = bridge.confirmDialog
      ? await bridge.confirmDialog(
          workspaceSessions.length === 0
            ? {
                title: "Delete workspace",
                message: "Delete this workspace?",
                detail: "This cannot be undone.",
              }
            : hasActiveSessions
              ? {
                  title: "Delete archived sessions",
                  message:
                    "Delete archived sessions under this workspace?",
                  detail:
                    "Active sessions stay. Deleted sessions are summarized into work history. This cannot be undone.",
                }
              : {
                  title: "Delete workspace",
                  message: "Delete this workspace and all its sessions?",
                  detail:
                    "Deleted sessions are summarized into work history. This cannot be undone.",
                },
        )
      : window.confirm(
          workspaceSessions.length === 0
            ? "Delete this workspace? This cannot be undone."
            : hasActiveSessions
              ? "Delete archived sessions under this workspace? Active sessions stay. Deleted sessions are summarized into work history. This cannot be undone."
              : "Delete this workspace and all its sessions? Deleted sessions are summarized into work history. This cannot be undone.",
        );
    if (!ok) return;
    try {
      const viewingDeleted =
        this.activeSessionId != null &&
        (hasActiveSessions
          ? archivedSessionIds.has(this.activeSessionId)
          : workspaceSessions.some((s) => s.id === this.activeSessionId));
      await bridge.deleteWorkspace(workspaceId);
      if (viewingDeleted) {
        this.sidebar.selectNav("new-task");
        this.showNavScreen("new-task");
      }
      await this.refreshSidebar();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (bridge.alertDialog) {
        await bridge.alertDialog({ message, type: "error", title: "Error" });
      } else {
        window.alert(message);
      }
    }
  }

  private async archiveWorkspaceFlow(workspaceId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.setWorkspaceArchived) return;
    try {
      await bridge.setWorkspaceArchived({
        workspaceId,
        archived: true,
      });
      await refreshWorkspacesState();
      await this.refreshSidebar();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (bridge.alertDialog) {
        await bridge.alertDialog({ message, type: "warning", title: "Archive" });
      } else {
        window.alert(message);
      }
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.deleteSession) return;
    const wasActive = this.activeSessionId === sessionId;
    // Resolve the successor before the refresh drops the deleted row.
    const successorId = wasActive ? this.pickSuccessorSessionId(sessionId) : null;
    const workspaceId =
      this.agentSessionItems.find((s) => s.id === sessionId)?.workspaceId ??
      null;
    try {
      const deleted = await bridge.deleteSession(sessionId);
      if (!deleted) return;
      if (wasActive) {
        if (this.devMode) {
          // Deleting the open session must not drop out of Dev Mode: land on
          // the neighbouring session, or the embedded New Task form.
          if (successorId) {
            this.openSession(successorId);
          } else {
            this.activeSessionId = null;
            this.devTools.setSessionId(null);
            this.syncFocusedHighlight();
            this.devMode.showNewTask(workspaceId);
          }
        } else {
          this.showNavScreen("new-task");
        }
      }
      await refreshWorkspacesState();
      await this.refreshSidebar();
    } catch (err) {
      console.error("[shell] failed to delete session", sessionId, err);
    }
  }

  /**
   * Neighbour of a session about to be deleted, within its own workspace and
   * in the switcher's order (newest first): the row below, else the row above.
   */
  private pickSuccessorSessionId(sessionId: string): string | null {
    const current = this.agentSessionItems.find((s) => s.id === sessionId);
    if (!current) return null;
    const siblings = this.agentSessionItems
      .filter((s) => s.workspaceId === current.workspaceId && !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const index = siblings.findIndex((s) => s.id === sessionId);
    if (index < 0) return null;
    return siblings[index + 1]?.id ?? siblings[index - 1]?.id ?? null;
  }

  /**
   * Archive one session. The open conversation (if viewing) stays open —
   * it only leaves the PROJECTS tree (matches workspace archive behavior).
   */
  private async setSessionArchivedFlow(
    sessionId: string,
    archived: boolean,
  ): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.setSessionArchived) return;
    try {
      await bridge.setSessionArchived({ sessionId, archived });
      await refreshWorkspacesState();
      await this.refreshSidebar();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (bridge.alertDialog) {
        await bridge.alertDialog({
          message,
          type: "warning",
          title: archived ? "Archive" : "Unarchive",
        });
      } else {
        window.alert(message);
      }
    }
  }

  private archiveSessionFlow(sessionId: string): Promise<void> {
    return this.setSessionArchivedFlow(sessionId, true);
  }

  private unarchiveSessionFlow(sessionId: string): Promise<void> {
    return this.setSessionArchivedFlow(sessionId, false);
  }

  private markSessionUnreadIfBackground(sessionId: string): void {
    if (!sessionId || sessionId === this.activeSessionId) return;
    if (this.unreadSessionIds.has(sessionId)) return;
    this.unreadSessionIds.add(sessionId);
    this.sidebar.setUnreadSessionIds(this.unreadSessionIds);
  }

  private openSession(
    sessionId: string,
    options?: {
      optimisticUserText?: string;
      attachments?: PendingAttachment[];
      /** Workspace New Task started the session in (beats the stale list). */
      workspaceId?: string | null;
    },
  ): void {
    // Workspace remembered Dev Mode → enter first so the conversation lands
    // in the workbench chat pane (plan decision #3). Prefer the explicit
    // workspaceId: a fresh session may not be in agentSessionItems yet.
    if (!this.devMode) {
      const wsId =
        options?.workspaceId ??
        this.agentSessionItems.find((s) => s.id === sessionId)?.workspaceId ??
        null;
      if (wsId && readDevModeMemory(wsId)) this.enterDevMode(false);
    }
    this.sidebar.clearNavSelection();
    this.titleBar.setSettingsActive(false);
    if (this.devMode) {
      // Dev Mode: conversation mounts into the workbench chat pane.
      this.activeSessionId = sessionId;
      this.syncDevModeWorkspace();
      if (this.unreadSessionIds.delete(sessionId)) {
        this.sidebar.setUnreadSessionIds(this.unreadSessionIds);
      }
      this.devTools.setSessionId(sessionId);
      this.syncFocusedHighlight();
      this.devMode.setSession(sessionId, options);
      return;
    }
    this.activeScreen?.destroy();
    this.activeScreen = undefined;
    this.activeSessionId = sessionId;
    if (this.unreadSessionIds.delete(sessionId)) {
      this.sidebar.setUnreadSessionIds(this.unreadSessionIds);
    }
    this.devTools.setSessionId(sessionId);
    this.syncFocusedHighlight();
    try {
      const screen = new ConversationController(new ConversationView(), sessionId, {
        ...options,
        // `/dev` toggles the workbench layout (same as the titlebar button).
        onToggleDevMode: () => this.toggleDevMode(),
      });
      this.activeScreen = screen;
      this.view.mainSlot.replaceChildren(screen.mount());
    } catch (err) {
      console.error("[shell] failed to open session", sessionId, err);
      this.activeSessionId = null;
      this.devTools.setSessionId(null);
      this.syncFocusedHighlight();
      const fallback = document.createElement("div");
      fallback.className = "screen";
      fallback.textContent =
        err instanceof Error
          ? `Failed to open session: ${err.message}`
          : "Failed to open session.";
      this.view.mainSlot.replaceChildren(fallback);
    }
  }

  private toggleDevMode(): void {
    if (this.devMode) {
      this.exitDevMode();
    } else {
      this.enterDevMode();
    }
  }

  /**
   * A parked ⌘W (macOS) / Ctrl+F4 (Windows) close arrived from the main
   * process. Dev Mode with file tabs consumes it one tab at a time; any
   * other state returns false so the caller closes the window for real.
   */
  consumeCloseShortcut(): boolean {
    return this.devMode?.closeActiveTab() ?? false;
  }

  /**
   * Enter the Dev Mode workbench: the Solution Outline replaces the sidebar
   * tree, the workbench replaces the main screen. carrySession=false defers
   * session mounting to the caller — openSession's memory path follows with
   * setSession right after, avoiding a double ConversationController mount.
   */
  private enterDevMode(carrySession = true): void {
    if (this.devMode) return;
    this.devModeWorkspaceId = this.getFocusedWorkspaceId();
    writeDevModeMemory(this.devModeWorkspaceId, true);
    this.activeScreen?.destroy();
    this.activeScreen = undefined;
    this.devMode = new DevModeController({
      getSessionTitle: (id) =>
        this.agentSessionItems.find((s) => s.id === id)?.title,
      onOpenSession: (id, options) => this.openSession(id, options),
      onWorkspaceChanged: () => {
        void this.refreshSidebar();
      },
      getSessionWorkspacePath: (id) => {
        const wsId = this.agentSessionItems.find((s) => s.id === id)
          ?.workspaceId;
        if (!wsId) return null;
        return (
          getWorkspacesState().workspaces.find((w) => w.id === wsId)?.path ??
          null
        );
      },
      getWorkspaceSessions: (wsId) =>
        this.agentSessionItems
          .filter((s) => s.workspaceId === wsId && !s.archived)
          .map((s) => ({
            id: s.id,
            title: s.title,
            ...(s.status ? { status: s.status } : {}),
            updatedAt: s.updatedAt,
          })),
      getWorkspaces: () =>
        getWorkspacesState().workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
        })),
      // Session hover actions in the switcher dropdown (sidebar parity).
      onArchiveSession: (sessionId) => {
        void this.archiveSessionFlow(sessionId);
      },
      onDeleteSession: (sessionId) => {
        void this.deleteSession(sessionId);
      },
      // `/dev` inside the workbench exits to the normal layout.
      onExitDevMode: () => this.exitDevMode(),
    });
    this.devMode.mount(this.view.sidebarSlot, this.view.mainSlot);
    this.view.setDevModeActive(true);
    this.view.setDevModeLayout(true);
    this.titleBar.setDevModeActive(true);
    if (carrySession && this.activeSessionId) {
      this.devMode.setSession(this.activeSessionId);
    } else if (carrySession) {
      // No session open: follow New Task's default workspace — its first
      // session loads into the chat pane, or the New Task form if none.
      const wsId = this.getNewTaskDefaultWorkspaceId();
      const first = wsId
        ? this.agentSessionItems.find(
            (s) => s.workspaceId === wsId && !s.archived,
          )
        : undefined;
      if (first) {
        this.openSession(first.id);
      } else {
        this.devMode.showNewTask();
      }
    }
  }

  /** Mirror New Task's workspace picker default (activeWorkspaceId ?? first). */
  private getNewTaskDefaultWorkspaceId(): string | null {
    const state = getWorkspacesState();
    return state.activeWorkspaceId ?? state.workspaces[0]?.id ?? null;
  }

  /**
   * Keep the per-workspace Dev Mode memory in step while the workbench
   * follows session switches across projects: clear the workspace we are
   * leaving, remember the one we land on. No-op when unchanged.
   */
  private syncDevModeWorkspace(): void {
    if (!this.devMode) return;
    const wsId = this.getFocusedWorkspaceId();
    if (wsId === this.devModeWorkspaceId) return;
    writeDevModeMemory(this.devModeWorkspaceId, false);
    this.devModeWorkspaceId = wsId;
    writeDevModeMemory(wsId, true);
  }

  /** Exit Dev Mode: restore the sidebar tree and the normal main screen. */
  private exitDevMode(): void {
    if (!this.devMode) return;
    const sessionId = this.activeSessionId;
    writeDevModeMemory(this.devModeWorkspaceId ?? this.getFocusedWorkspaceId(), false);
    this.devModeWorkspaceId = null;
    this.devMode.destroy();
    this.devMode = null;
    this.view.sidebarSlot.replaceChildren(this.sidebar.mount());
    this.view.setDevModeActive(false);
    this.view.setDevModeLayout(false);
    this.titleBar.setDevModeActive(false);
    if (sessionId) {
      this.openSession(sessionId);
    } else {
      this.showNavScreen(this.sidebar.getActiveNav() ?? "new-task");
    }
  }

  private showSettingScreen(category: "appearance" | "coco" = "appearance"): void {
    // Idempotent: the menubar action re-entering while active must not
    // reset the form (the gear itself toggles out instead).
    if (this.activeScreen instanceof SettingController) return;
    this.settingsResume = this.captureSettingsResume();
    if (this.devMode) this.exitDevMode();
    this.sidebar.clearNavSelection();
    this.titleBar.setSettingsActive(true);
    this.activeScreen?.destroy();
    this.activeSessionId = null;
    this.devTools.setSessionId(null);
    this.syncFocusedHighlight();
    this.activeScreen = new SettingController(new SettingView(category));
    this.view.mainSlot.replaceChildren(this.activeScreen.mount());
  }

  /** Gear toggles: enter Settings, or leave back to the pre-Settings screen. */
  private toggleSettingScreen(): void {
    if (this.activeScreen instanceof SettingController) {
      this.exitSettingScreen();
    } else {
      this.showSettingScreen();
    }
  }

  /**
   * Snapshot the screen Settings is about to replace. Dev Mode must be
   * captured before showSettingScreen tears the workbench down.
   */
  private captureSettingsResume(): SettingsResumeTarget {
    if (this.devMode) {
      return { kind: "dev-mode", sessionId: this.activeSessionId };
    }
    if (this.activeSessionId) {
      return { kind: "session", sessionId: this.activeSessionId };
    }
    if (this.activeScreen instanceof GraphEditorController) {
      return { kind: "graph-editor", graphId: this.activeScreen.graphId };
    }
    return { kind: "nav", id: this.sidebar.getActiveNav() ?? "new-task" };
  }

  /** Gear toggled off: return to the screen captured on Settings entry. */
  private exitSettingScreen(): void {
    const resume: SettingsResumeTarget = this.settingsResume ?? {
      kind: "nav",
      id: this.sidebar.getActiveNav() ?? "new-task",
    };
    this.settingsResume = undefined;
    this.titleBar.setSettingsActive(false);
    switch (resume.kind) {
      case "session":
        // The session may have been deleted from the sidebar while in
        // Settings — land on New Task instead of a dead conversation.
        if (this.agentSessionItems.some((s) => s.id === resume.sessionId)) {
          this.openSession(resume.sessionId);
        } else {
          this.sidebar.selectNav("new-task");
        }
        return;
      case "graph-editor":
        this.openGraphEditor(resume.graphId);
        return;
      case "dev-mode": {
        this.enterDevMode(false);
        const sessionId =
          resume.sessionId &&
          this.agentSessionItems.some((s) => s.id === resume.sessionId)
            ? resume.sessionId
            : null;
        if (sessionId) {
          this.openSession(sessionId);
        } else {
          this.devMode?.showNewTask();
        }
        return;
      }
      case "nav":
        // selectNav drives the nav-change chain (row highlight + screen
        // swap); entry cleared the selection, so this re-fires.
        this.sidebar.selectNav(resume.id);
        return;
    }
  }

  private showNavScreen(id: AgentNavId): void {
    if (this.devMode) this.exitDevMode();
    this.titleBar.setSettingsActive(false);
    this.activeScreen?.destroy();
    this.activeSessionId = null;
    this.devTools.setSessionId(null);
    this.syncFocusedHighlight();
    this.activeScreen = this.createNavScreen(id);
    this.view.mainSlot.replaceChildren(this.activeScreen.mount());
  }

  private createNavScreen(id: AgentNavId): ScreenController {
    switch (id) {
      case "new-task":
        return new NewTaskController(new NewTaskView(), {
          onSessionStarted: (sessionId, options) => {
            void this.refreshSidebar();
            this.openSession(sessionId, options);
          },
          onWorkspaceChanged: () => {
            void this.refreshSidebar();
          },
        });
      case "loop":
        return new CocoController({
          onOpenSettings: () => this.showSettingScreen("coco"),
          onSessionSelect: (sessionId) => {
            this.openSession(sessionId);
          },
        });
      case "search":
        return new SearchController(new SearchView(), {
          onSessionSelect: (sessionId) => {
            this.openSession(sessionId);
          },
        });
      case "tools":
        return new ToolsController(new ToolsView());
      case "skills":
        return new SkillsController(new SkillsView());
      case "graphs":
        return new GraphsController(new GraphsView(), {
          onOpenGraph: (graphId) => this.openGraphEditor(graphId),
        });
    }
  }

  private openGraphEditor(graphId: string): void {
    if (this.devMode) this.exitDevMode();
    this.titleBar.setSettingsActive(false);
    this.sidebar.selectNav("graphs");
    this.activeScreen?.destroy();
    this.activeSessionId = null;
    this.devTools.setSessionId(null);
    this.syncFocusedHighlight();
    this.activeScreen = new GraphEditorController(new GraphEditorView(), {
      graphId,
      onBack: () => this.showNavScreen("graphs"),
    });
    this.view.mainSlot.replaceChildren(this.activeScreen.mount());
  }
}
