import { createLucideIcon as createOriginalIcon } from "../ui/originalIcons.js";
import { createCocoMonoMark, createCocoTakeBackMark } from "../ui/cocoMonoMark.js";
import { RotateCcwClock } from "lucide";
import { formatRelativeTime } from "../navigation/formatRelativeTime.js";
import type {
  SessionListItem,
  WorkspaceListItem,
} from "../navigation/types.js";
import {
  Archive,
  ChevronDown,
  Pencil,
  Plus,
  Search,
  Trash2,
  createLucideIcon,
} from "../ui/icons.js";

export type WorkspaceSectionRenderState = {
  workspaces: readonly WorkspaceListItem[];
  sessionsByWorkspace: ReadonlyMap<string, readonly SessionListItem[]>;
  /** Workspace of the currently open session; null when no session is focused. */
  focusedWorkspaceId: string | null;
  /** Session currently open in the main conversation view; null otherwise. */
  focusedSessionId: string | null;
  /** Sessions with unread turn completions (not currently viewing). */
  unreadSessionIds: ReadonlySet<string>;
  /** Workspaces rendered with their nested session list hidden. */
  collapsedWorkspaceIds: ReadonlySet<string>;
  /** CoCo engine unavailable (disabled/blocked) — hide the handover entry. */
  cocoUnavailable?: boolean;
};

/**
 * Collapsible "Projects" sidebar section: workspaces with nested sessions.
 *
 * Workspace groups and session rows are patched in place so the running
 * spinner is not remounted on every sidebar refresh (which would restart
 * its CSS animation). Collapse state is owned by the controller and applied
 * from the render state on every pass.
 */
export class WorkspaceSectionView {
  readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly searchBtn: HTMLButtonElement;
  private readonly addWorkspaceBtn: HTMLButtonElement;
  private readonly archivedBtn: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly listEl: HTMLElement;
  private onSelectSession: ((sessionId: string) => void) | undefined;
  private onArchiveSession: ((sessionId: string) => void) | undefined;
  private onDeleteSession: ((sessionId: string) => void) | undefined;
  private onCreateWorkspace: (() => void) | undefined;
  private onOpenArchived: (() => void) | undefined;
  private onOpenSearch: (() => void) | undefined;
  private onNewSession: ((workspaceId: string) => void) | undefined;
  private onRenameWorkspace:
    | ((
        workspaceId: string,
        currentName: string,
        currentPath: string,
      ) => void)
    | undefined;
  private onArchiveWorkspace: ((workspaceId: string) => void) | undefined;
  private onDeleteWorkspace: ((workspaceId: string) => void) | undefined;
  private onToggleWorkspace:
    | ((workspaceId: string, collapsed: boolean) => void)
    | undefined;
  private onHandoverSession: ((sessionId: string) => void) | undefined;
  private onTakeBackSession: ((sessionId: string) => void) | undefined;
  /** Render-state flag: CoCo engine unreachable ⇒ handover entry hidden. */
  private cocoUnavailable = false;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "sidebar-session-section sidebar-workspace-section";
    this.root.dataset.section = "workspaces";

    const headerRow = document.createElement("div");
    headerRow.className = "sidebar-section-header-row";

    this.headerEl = document.createElement("div");
    this.headerEl.className = "sidebar-section-header";

    const label = document.createElement("span");
    label.className = "sidebar-section-title";
    label.textContent = "Projects";

    this.headerEl.append(label);

    this.searchBtn = document.createElement("button");
    this.searchBtn.type = "button";
    this.searchBtn.className = "sidebar-section-search sidebar-rail-btn";
    this.searchBtn.title = "Search tasks";
    this.searchBtn.setAttribute("aria-label", "Search tasks");
    this.searchBtn.append(createLucideIcon(Search, { size: 14 }));

    this.archivedBtn = document.createElement("button");
    this.archivedBtn.type = "button";
    this.archivedBtn.className = "sidebar-section-archived sidebar-rail-btn";
    this.archivedBtn.title = "Archived projects";
    this.archivedBtn.setAttribute("aria-label", "Archived projects");
    this.archivedBtn.append(createLucideIcon(Archive, { size: 14 }));

    this.addWorkspaceBtn = document.createElement("button");
    this.addWorkspaceBtn.type = "button";
    this.addWorkspaceBtn.className = "sidebar-section-add";
    this.addWorkspaceBtn.title = "New workspace";
    this.addWorkspaceBtn.setAttribute("aria-label", "New workspace");
    this.addWorkspaceBtn.append(createLucideIcon(Plus, { size: 14 }));

    headerRow.append(
      this.headerEl,
      this.searchBtn,
      this.archivedBtn,
      this.addWorkspaceBtn,
    );

    this.body = document.createElement("div");
    this.body.className = "sidebar-section-body";

    this.listEl = document.createElement("div");
    this.listEl.className = "workspace-tree";

    this.body.append(this.listEl);
    this.root.append(headerRow, this.body);

    this.addWorkspaceBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onCreateWorkspace?.();
    });

    this.archivedBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onOpenArchived?.();
    });

    this.searchBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onOpenSearch?.();
    });

    this.listEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const cocoHandoverBtn = target.closest<HTMLButtonElement>(
        ".session-row-coco",
      );
      if (cocoHandoverBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = cocoHandoverBtn.dataset.sessionId;
        if (id) {
          if (cocoHandoverBtn.dataset.mode === "takeback") this.onTakeBackSession?.(id);
          else this.onHandoverSession?.(id);
        }
        return;
      }

      const sessionDeleteBtn = target.closest<HTMLButtonElement>(
        ".session-row-delete",
      );
      if (sessionDeleteBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = sessionDeleteBtn.dataset.sessionId;
        if (id) this.onDeleteSession?.(id);
        return;
      }

      const archiveSessionBtn = target.closest<HTMLButtonElement>(
        ".session-row-archive",
      );
      if (archiveSessionBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = archiveSessionBtn.dataset.sessionId;
        if (id) this.onArchiveSession?.(id);
        return;
      }

      const archiveWsBtn = target.closest<HTMLButtonElement>(
        ".workspace-row-archive",
      );
      if (archiveWsBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = archiveWsBtn.dataset.workspaceId;
        if (id) this.onArchiveWorkspace?.(id);
        return;
      }

      const deleteWsBtn = target.closest<HTMLButtonElement>(
        ".workspace-row-delete",
      );
      if (deleteWsBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = deleteWsBtn.dataset.workspaceId;
        if (id) this.onDeleteWorkspace?.(id);
        return;
      }

      const renameWsBtn = target.closest<HTMLButtonElement>(
        ".workspace-row-rename",
      );
      if (renameWsBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = renameWsBtn.dataset.workspaceId;
        const name = renameWsBtn.dataset.workspaceName ?? "";
        const path = renameWsBtn.dataset.workspacePath ?? "";
        if (id) this.onRenameWorkspace?.(id, name, path);
        return;
      }

      const newSessionBtn = target.closest<HTMLButtonElement>(
        ".workspace-row-add",
      );
      if (newSessionBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = newSessionBtn.dataset.workspaceId;
        if (id) this.onNewSession?.(id);
        return;
      }

      const toggleBtn = target.closest<HTMLElement>(".workspace-row-toggle");
      if (toggleBtn) {
        event.preventDefault();
        event.stopPropagation();
        const group = toggleBtn.closest<HTMLElement>(".workspace-group");
        const id = group?.dataset.workspaceId;
        if (group && id) {
          const collapsed = !group.classList.contains("is-collapsed");
          this.onToggleWorkspace?.(id, collapsed);
        }
        return;
      }

      const row = target.closest<HTMLElement>(".session-row");
      const id = row?.dataset.sessionId;
      if (id) this.onSelectSession?.(id);
    });
  }

  render(state: WorkspaceSectionRenderState): void {    const {
      workspaces,
      sessionsByWorkspace,
      focusedWorkspaceId,
      focusedSessionId,
      unreadSessionIds,
      collapsedWorkspaceIds,
    } = state;
    this.cocoUnavailable = state.cocoUnavailable === true;

    const existing = new Map<string, HTMLElement>();
    for (const child of this.listEl.children) {
      if (!(child instanceof HTMLElement)) continue;
      const id = child.dataset.workspaceId;
      if (id) existing.set(id, child);
    }

    const keep = new Set(workspaces.map((w) => w.id));
    for (const [id, group] of existing) {
      if (!keep.has(id)) {
        group.remove();
        existing.delete(id);
      }
    }

    workspaces.forEach((workspace, index) => {
      const sessions = sessionsByWorkspace.get(workspace.id) ?? [];
      const isActive = workspace.id === focusedWorkspaceId;
      const isCollapsed = collapsedWorkspaceIds.has(workspace.id);
      let group = existing.get(workspace.id);
      if (!group) {
        group = this.createWorkspaceGroup(
          workspace,
          sessions,
          isActive,
          focusedSessionId,
          unreadSessionIds,
        );
        existing.set(workspace.id, group);
      } else {
        this.patchWorkspaceGroup(
          group,
          workspace,
          sessions,
          isActive,
          focusedSessionId,
          unreadSessionIds,
        );
      }
      this.applyGroupCollapsed(group, isCollapsed);

      const current = this.listEl.children.item(index);
      if (current !== group) {
        this.listEl.insertBefore(group, current);
      }
    });
  }

  private applyGroupCollapsed(group: HTMLElement, collapsed: boolean): void {
    const wasCollapsed = group.dataset.collapsed === "1";
    group.dataset.collapsed = collapsed ? "1" : "0";
    group.classList.toggle("is-collapsed", collapsed);
    const toggle = group.querySelector(".workspace-row-toggle");
    if (toggle instanceof HTMLElement) {
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    // Stagger the session cards in when a group expands (never on first paint:
    // dataset starts empty, so wasCollapsed is only true after a real collapse).
    if (wasCollapsed && !collapsed) this.revealSessionCards(group);
  }

  /** One-shot staggered slide+fade for the rows under an expanding group. */
  private revealSessionCards(group: HTMLElement): void {
    const list = group.querySelector<HTMLElement>(".workspace-sessions");
    if (!list) return;
    const rows = list.querySelectorAll<HTMLElement>(".session-row");
    if (rows.length === 0) return;
    const stepMs = Math.min(28, Math.max(12, 160 / rows.length));
    rows.forEach((row, index) => {
      row.style.setProperty("--reveal-delay", `${Math.round(index * stepMs)}ms`);
    });
    list.classList.remove("is-revealing");
    // Restart the animation if a previous reveal is still mid-flight.
    void list.offsetWidth;
    list.classList.add("is-revealing");
    window.setTimeout(
      () => {
        list.classList.remove("is-revealing");
        rows.forEach((row) => row.style.removeProperty("--reveal-delay"));
      },
      Math.round(rows.length * stepMs) + 320,
    );
  }

  private createWorkspaceGroup(
    workspace: WorkspaceListItem,
    sessions: readonly SessionListItem[],
    isActive: boolean,
    focusedSessionId: string | null,
    unreadSessionIds: ReadonlySet<string>,
  ): HTMLElement {
    const group = document.createElement("div");
    group.className = "workspace-group";
    group.dataset.workspaceId = workspace.id;
    if (isActive) group.classList.add("is-active");

    const row = document.createElement("div");
    row.className = "workspace-row";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "workspace-row-toggle";
    toggle.setAttribute("aria-expanded", "true");
    toggle.title = workspace.path;

    const icon = document.createElement("span");
    icon.className = "workspace-row-icon";

    // Disclosure chevron only — always visible so collapsed/expanded state
    // reads at a glance (package-icon hover swap hid the state affordance).
    const chevronIcon = document.createElement("span");
    chevronIcon.className = "workspace-row-icon-chevron";
    chevronIcon.setAttribute("aria-hidden", "true");
    chevronIcon.append(createOriginalIcon(ChevronDown, { size: 16 }));

    icon.append(chevronIcon);

    const name = document.createElement("span");
    name.className = "workspace-row-name";
    name.textContent = workspace.name;
    // CoCo-created projects carry the band mark so provenance reads at a glance.
    if (workspace.origin === "coco") {
      const mark = createCocoMonoMark(12);
      mark.classList.add("workspace-row-coco-mark");
      mark.title = "Created by CoCo";
      toggle.append(icon, mark, name);
    } else {
      toggle.append(icon, name);
    }


    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "workspace-row-add sidebar-rail-btn";
    addBtn.dataset.workspaceId = workspace.id;
    addBtn.title = "New Task";
    addBtn.setAttribute("aria-label", "New Task");
    addBtn.append(createLucideIcon(Plus, { size: 14 }));

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "workspace-row-rename sidebar-rail-btn";
    renameBtn.dataset.workspaceId = workspace.id;
    renameBtn.dataset.workspaceName = workspace.name;
    renameBtn.dataset.workspacePath = workspace.path;
    renameBtn.title = "Edit workspace";
    renameBtn.setAttribute("aria-label", "Edit workspace");
    renameBtn.append(createLucideIcon(Pencil, { size: 14 }));

    // Empty projects (no sessions left in the tree) swap Archive for Delete.
    const actionBtn = this.createWorkspaceRowAction(sessions.length > 0);
    actionBtn.dataset.workspaceId = workspace.id;

    row.append(toggle, addBtn, renameBtn, actionBtn);

    const sessionList = document.createElement("div");
    sessionList.className = "workspace-sessions sessions-list";
    this.patchSessionList(
      sessionList,
      sessions,
      focusedSessionId,
      unreadSessionIds,
    );

    // Wrapper exists purely so collapse can animate height + mask reveal.
    const sessionClip = document.createElement("div");
    sessionClip.className = "workspace-sessions-clip";
    sessionClip.append(sessionList);

    group.append(row, sessionClip);
    return group;
  }

  private patchWorkspaceGroup(
    group: HTMLElement,
    workspace: WorkspaceListItem,
    sessions: readonly SessionListItem[],
    isActive: boolean,
    focusedSessionId: string | null,
    unreadSessionIds: ReadonlySet<string>,
  ): void {
    group.dataset.workspaceId = workspace.id;
    group.classList.toggle("is-active", isActive);

    const name = group.querySelector(".workspace-row-name");
    if (name) name.textContent = workspace.name;

    const toggle = group.querySelector(".workspace-row-toggle");
    if (toggle instanceof HTMLElement) {
      toggle.title = workspace.path;
    }

    const addBtn = group.querySelector(".workspace-row-add");
    if (addBtn instanceof HTMLButtonElement) {
      addBtn.dataset.workspaceId = workspace.id;
    }

    const renameBtn = group.querySelector(".workspace-row-rename");
    if (renameBtn instanceof HTMLButtonElement) {
      renameBtn.dataset.workspaceId = workspace.id;
      renameBtn.dataset.workspaceName = workspace.name;
      renameBtn.dataset.workspacePath = workspace.path;
    }

    this.syncWorkspaceRowAction(group, sessions.length > 0);

    const sessionList = group.querySelector(".workspace-sessions");
    if (sessionList instanceof HTMLElement) {
      this.patchSessionList(
        sessionList,
        sessions,
        focusedSessionId,
        unreadSessionIds,
      );
    }
  }

  /**
   * Trailing hover action of a workspace row: Archive while the project owns
   * sessions, Delete once none are left in the tree (empty or fully
   * archived — archived sessions never show in the PROJECTS tree).
   */
  private createWorkspaceRowAction(hasSessions: boolean): HTMLButtonElement {
    if (!hasSessions) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "workspace-row-delete sidebar-rail-btn";
      deleteBtn.title = "Delete workspace";
      deleteBtn.setAttribute("aria-label", "Delete workspace");
      deleteBtn.append(createLucideIcon(Trash2, { size: 14 }));
      return deleteBtn;
    }
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "workspace-row-archive sidebar-rail-btn";
    archiveBtn.title = "Archive all tasks";
    archiveBtn.setAttribute("aria-label", "Archive all tasks");
    archiveBtn.append(createLucideIcon(Archive, { size: 14 }));
    return archiveBtn;
  }

  /**
   * Keep the row action in sync across patches: a project that loses its
   * last session (archived or deleted away) flips its hover action to
   * Delete; gaining one flips back to Archive.
   */
  private syncWorkspaceRowAction(
    group: HTMLElement,
    hasSessions: boolean,
  ): void {
    const row = group.querySelector(".workspace-row");
    if (!(row instanceof HTMLElement)) return;
    const wanted = row.querySelector<HTMLButtonElement>(
      hasSessions ? ".workspace-row-archive" : ".workspace-row-delete",
    );
    if (wanted instanceof HTMLButtonElement) {
      wanted.dataset.workspaceId = group.dataset.workspaceId ?? "";
      return;
    }
    row.querySelector(".workspace-row-archive")?.remove();
    row.querySelector(".workspace-row-delete")?.remove();
    const btn = this.createWorkspaceRowAction(hasSessions);
    btn.dataset.workspaceId = group.dataset.workspaceId ?? "";
    const anchor = row.querySelector(".workspace-row-rename");
    if (anchor instanceof Element) {
      anchor.insertAdjacentElement("afterend", btn);
    } else {
      row.append(btn);
    }
  }

  private patchSessionList(
    listEl: HTMLElement,
    sessions: readonly SessionListItem[],
    focusedSessionId: string | null,
    unreadSessionIds: ReadonlySet<string>,
  ): void {
    const existing = new Map<string, HTMLElement>();
    for (const child of listEl.children) {
      if (!(child instanceof HTMLElement)) continue;
      const id = child.dataset.sessionId;
      if (id) existing.set(id, child);
    }

    const keep = new Set(sessions.map((item) => item.id));
    for (const [id, row] of existing) {
      if (!keep.has(id)) {
        row.remove();
        existing.delete(id);
      }
    }

    sessions.forEach((item, index) => {
      const isViewing = item.id === focusedSessionId;
      const unread = !isViewing && unreadSessionIds.has(item.id);
      let row = existing.get(item.id);
      if (!row) {
        row = this.createSessionRow(item, isViewing, unread);
        existing.set(item.id, row);
      } else {
        this.patchSessionRow(row, item, isViewing, unread);
      }

      const current = listEl.children.item(index);
      if (current !== row) {
        listEl.insertBefore(row, current);
      }
    });
  }

  private createSessionRow(
    item: SessionListItem,
    isViewing: boolean,
    unread: boolean,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "session-row";
    row.dataset.sessionId = item.id;
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const leading = document.createElement("span");
    leading.className = "session-leading";
    leading.setAttribute("aria-hidden", "true");

    const title = document.createElement("span");
    title.className = "session-title";

    const trailing = document.createElement("span");
    trailing.className = "session-trailing";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "session-row-delete sidebar-rail-btn";
    deleteBtn.dataset.sessionId = item.id;
    deleteBtn.title = "Delete";
    deleteBtn.setAttribute("aria-label", "Delete task");
    deleteBtn.append(createLucideIcon(Trash2, { size: 14 }));

    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "session-row-archive sidebar-rail-btn";
    archiveBtn.dataset.sessionId = item.id;
    archiveBtn.title = "Archive";
    archiveBtn.setAttribute("aria-label", "Archive task");
    archiveBtn.append(createLucideIcon(Archive, { size: 14 }));

    const handoverBtn = document.createElement("button");
    handoverBtn.type = "button";
    handoverBtn.className = "session-row-coco sidebar-rail-btn";
    handoverBtn.dataset.sessionId = item.id;
    // Label/aria/icon are owned by patchSessionRow (dual-mode button).

    row.append(leading, title, trailing, handoverBtn, deleteBtn, archiveBtn);
    this.patchSessionRow(row, item, isViewing, unread);

    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const id = row.dataset.sessionId;
        if (id) this.onSelectSession?.(id);
      }
    });

    return row;
  }

  private patchSessionRow(
    row: HTMLElement,
    item: SessionListItem,
    isViewing: boolean,
    unread: boolean,
  ): void {
    const running = item.status === "running";
    row.classList.toggle("is-running", running);
    row.classList.toggle("is-viewing", isViewing);
    row.classList.toggle("is-unread", unread);
    row.setAttribute("aria-current", isViewing ? "true" : "false");
    row.dataset.sessionId = item.id;

    // CoCo rail entry, dual-mode: "Hand over" on user rows (hidden while the
    // CoCo engine is unreachable), "Take back" on CoCo-managed rows (always
    // available — reclaiming must work with CoCo disabled). Rows without it
    // keep Delete at its original slot (see the .has-coco-entry rules in
    // shell.css).
    row.classList.toggle(
      "has-coco-entry",
      item.source === "coco" || !this.cocoUnavailable,
    );
    const handoverBtn = row.querySelector(".session-row-coco");
    if (handoverBtn instanceof HTMLButtonElement) {
      handoverBtn.dataset.sessionId = item.id;
      const mode = item.source === "coco" ? "takeback" : "handover";
      if (handoverBtn.dataset.mode !== mode) {
        handoverBtn.dataset.mode = mode;
        const label = mode === "takeback" ? "Take back from CoCo" : "Hand over to CoCo";
        handoverBtn.title = label;
        handoverBtn.setAttribute("aria-label", label);
        handoverBtn.replaceChildren(mode === "takeback" ? createCocoTakeBackMark(14) : createCocoMonoMark(14));
      }
    }

    this.syncLeading(row, item, isViewing, unread);

    const title = row.querySelector(".session-title");
    if (title) title.textContent = item.title;

    const deleteBtn = row.querySelector(".session-row-delete");
    if (deleteBtn instanceof HTMLButtonElement) {
      deleteBtn.dataset.sessionId = item.id;
      // Running sessions must be stopped first (main process refuses the
      // delete) — reflect it here so the button doesn't dead-click.
      deleteBtn.disabled = running;
      deleteBtn.title = running ? "Stop the task before deleting" : "Delete";
    }

    const archiveBtn = row.querySelector(".session-row-archive");
    if (archiveBtn instanceof HTMLButtonElement) {
      archiveBtn.dataset.sessionId = item.id;
      // Same as delete: running sessions must be stopped first, and hover
      // keeps the spinner instead of revealing the overlay actions.
      archiveBtn.disabled = running;
      archiveBtn.title = running ? "Stop the task before archiving" : "Archive";
    }

    const trailing = row.querySelector(".session-trailing");
    if (!(trailing instanceof HTMLElement)) return;

    const hadSpinner =
      trailing.querySelector(".session-running-spinner") !== null;
    if (running) {
      if (!hadSpinner) {
        trailing.replaceChildren();
        const spinner = document.createElement("span");
        spinner.className = "session-running-spinner";
        spinner.setAttribute("aria-label", "Running");
        spinner.setAttribute("role", "status");
        trailing.append(spinner);
      }
      return;
    }

    const timeEl = trailing.querySelector(".session-time");
    if (timeEl instanceof HTMLElement && !hadSpinner) {
      timeEl.textContent = formatRelativeTime(item.updatedAt);
      return;
    }

    trailing.replaceChildren();
    const time = document.createElement("span");
    time.className = "session-time";
    time.textContent = formatRelativeTime(item.updatedAt);
    trailing.append(time);
  }

  /**
   * Keep the 16px leading slot in sync: unread dot > Loop badge (RotateCcwClock)
   * > empty. Both live inside the fixed-width slot so the title start position
   * never shifts for Loop sessions.
   */
  private syncLeading(
    row: HTMLElement,
    item: SessionListItem,
    isViewing: boolean,
    unread: boolean,
  ): void {
    const leading = row.querySelector(".session-leading");
    if (!(leading instanceof HTMLElement)) return;
    const showDot = !isViewing && unread;
    const showBadge = !showDot && (item.source === "loop" || item.source === "coco");
    const hasDot = leading.querySelector(".session-unread-dot") !== null;
    const hasBadge = leading.querySelector(".session-loop-badge") !== null;
    if ((showDot && hasDot) || (showBadge && hasBadge)) return;
    if (showDot) {
      const dot = document.createElement("span");
      dot.className = "session-unread-dot";
      dot.title = "Unread";
      leading.replaceChildren(dot);
    } else if (showBadge) {
      const badge = document.createElement("span");
      badge.className = "session-loop-badge";
      badge.title = item.source === "coco" ? "CoCo execution task" : "Historical Loop task";
      badge.append(createLucideIcon(RotateCcwClock, { size: 12 }));
      leading.replaceChildren(badge);
    } else {
      leading.replaceChildren();
    }
  }

  onSessionSelect(handler: (sessionId: string) => void): void {
    this.onSelectSession = handler;
  }

  onCreateWorkspaceClick(handler: () => void): void {
    this.onCreateWorkspace = handler;
  }

  /** Anchor element for the new-workspace template dropdown (header `+`). */
  getAddWorkspaceButton(): HTMLButtonElement {
    return this.addWorkspaceBtn;
  }

  onArchivedProjectsClick(handler: () => void): void {
    this.onOpenArchived = handler;
  }

  onSearchClick(handler: () => void): void {
    this.onOpenSearch = handler;
  }

  /** Count shown via tooltip only ("Archived projects (3)"). */
  setArchivedCount(count: number): void {
    const label =
      count > 0 ? `Archived projects (${count})` : "Archived projects";
    this.archivedBtn.title = label;
    this.archivedBtn.setAttribute("aria-label", label);
  }

  onNewSessionClick(handler: (workspaceId: string) => void): void {
    this.onNewSession = handler;
  }

  onRenameWorkspaceClick(
    handler: (
      workspaceId: string,
      currentName: string,
      currentPath: string,
    ) => void,
  ): void {
    this.onRenameWorkspace = handler;
  }

  onSessionArchiveClick(handler: (sessionId: string) => void): void {
    this.onArchiveSession = handler;
  }

  onSessionDeleteClick(handler: (sessionId: string) => void): void {
    this.onDeleteSession = handler;
  }

  onSessionCocoHandover(handler: (sessionId: string) => void): void {
    this.onHandoverSession = handler;
  }

  onSessionCocoTakeBack(handler: (sessionId: string) => void): void {
    this.onTakeBackSession = handler;
  }

  onArchiveWorkspaceClick(handler: (workspaceId: string) => void): void {
    this.onArchiveWorkspace = handler;
  }

  onDeleteWorkspaceClick(handler: (workspaceId: string) => void): void {
    this.onDeleteWorkspace = handler;
  }

  onWorkspaceToggle(
    handler: (workspaceId: string, collapsed: boolean) => void,
  ): void {
    this.onToggleWorkspace = handler;
  }
}
