import { createLucideIcon as createOriginalIcon } from "../ui/originalIcons.js";
import { Trash2 } from "lucide";
import { formatRelativeTime } from "../navigation/formatRelativeTime.js";
import {
  ArchiveRestore,
  ChevronDown,
  ChevronLeft,
  createLucideIcon,
} from "../ui/icons.js";

export type ArchivedSessionItem = {
  id: string;
  title: string;
  updatedAt: number;
  archivedAt: number | null;
};

export type ArchivedProjectItem = {
  id: string; // workspace id
  name: string;
  path: string;
  archivedAt: number | null; // max of sessions' archivedAt
  /** True when PROJECTS still shows this workspace (has active sessions). */
  hasActiveSessions: boolean;
  sessions: readonly ArchivedSessionItem[];
};

/**
 * Archived Projects sidebar view — full replacement for the PROJECTS area
 * while open. Two-level tree: archived workspaces with their archived
 * sessions. Rows are static (no spinners), so render rebuilds the list.
 * Collapse state is view-local and not persisted.
 */
export class ArchivedProjectsView {
  readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private collapsedWorkspaceIds = new Set<string>();
  private onBack: (() => void) | undefined;
  private onUnarchive: ((workspaceId: string) => void) | undefined;
  private onDelete: ((workspaceId: string) => void) | undefined;
  private onSessionUnarchive: ((sessionId: string) => void) | undefined;
  private onSessionDelete: ((sessionId: string) => void) | undefined;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "sidebar-session-section archived-projects";
    this.root.dataset.section = "archived";

    const header = document.createElement("div");
    header.className = "sidebar-section-header-row archived-projects-header";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "archived-projects-back sidebar-rail-btn";
    backBtn.title = "Back to projects";
    backBtn.setAttribute("aria-label", "Back to projects");
    backBtn.append(createLucideIcon(ChevronLeft, { size: 16 }));

    const backLabel = document.createElement("span");
    backLabel.className = "archived-projects-back-label";
    backLabel.textContent = "Archived";
    backBtn.append(backLabel);

    backBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onBack?.();
    });

    header.append(backBtn);

    this.listEl = document.createElement("div");
    this.listEl.className = "archived-projects-list";

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "archived-projects-empty";
    this.emptyEl.textContent = "No archived tasks.";
    this.emptyEl.hidden = true;

    const body = document.createElement("div");
    body.className = "sidebar-section-body";
    body.append(this.listEl, this.emptyEl);

    this.root.append(header, body);

    this.listEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const sessionUnarchiveBtn = target.closest<HTMLButtonElement>(
        ".archived-session-unarchive",
      );
      if (sessionUnarchiveBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = sessionUnarchiveBtn.dataset.sessionId;
        if (id) this.onSessionUnarchive?.(id);
        return;
      }

      const sessionDeleteBtn = target.closest<HTMLButtonElement>(
        ".archived-session-delete",
      );
      if (sessionDeleteBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = sessionDeleteBtn.dataset.sessionId;
        if (id) this.onSessionDelete?.(id);
        return;
      }

      const unarchiveBtn = target.closest<HTMLButtonElement>(
        ".archived-row-unarchive",
      );
      if (unarchiveBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = unarchiveBtn.dataset.workspaceId;
        if (id) this.onUnarchive?.(id);
        return;
      }

      const deleteBtn = target.closest<HTMLButtonElement>(
        ".archived-row-delete",
      );
      if (deleteBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = deleteBtn.dataset.workspaceId;
        if (id) this.onDelete?.(id);
        return;
      }

      const toggleBtn = target.closest<HTMLElement>(".archived-row-toggle");
      if (toggleBtn) {
        event.preventDefault();
        event.stopPropagation();
        const group = toggleBtn.closest<HTMLElement>(".archived-group");
        const id = group?.dataset.workspaceId;
        if (group && id) {
          const collapsed = !group.classList.contains("is-collapsed");
          this.setGroupCollapsed(id, group, collapsed);
        }
      }
    });
  }

  render(items: readonly ArchivedProjectItem[]): void {
    this.emptyEl.hidden = items.length > 0;
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.append(this.createGroup(item));
    }
    this.listEl.replaceChildren(fragment);
  }

  private createGroup(item: ArchivedProjectItem): HTMLElement {
    const group = document.createElement("div");
    group.className = "archived-group";
    group.dataset.workspaceId = item.id;

    const row = document.createElement("div");
    row.className = "archived-row";
    row.dataset.workspaceId = item.id;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "archived-row-toggle";
    toggle.setAttribute("aria-expanded", "true");
    toggle.title = item.path;

    const icon = document.createElement("span");
    icon.className = "archived-row-icon";
    icon.setAttribute("aria-hidden", "true");

    // Disclosure chevron only — mirrors the Projects tree (state at a glance).
    const chevronIcon = document.createElement("span");
    chevronIcon.className = "archived-row-icon-chevron";
    chevronIcon.append(createOriginalIcon(ChevronDown, { size: 16 }));

    icon.append(chevronIcon);

    const name = document.createElement("span");
    name.className = "archived-row-name";
    name.textContent = item.name;

    toggle.append(icon, name);

    const unarchiveBtn = document.createElement("button");
    unarchiveBtn.type = "button";
    unarchiveBtn.className = "archived-row-unarchive sidebar-rail-btn";
    unarchiveBtn.dataset.workspaceId = item.id;
    unarchiveBtn.title = "Unarchive all tasks";
    unarchiveBtn.setAttribute("aria-label", "Unarchive all tasks");
    unarchiveBtn.append(createLucideIcon(ArchiveRestore, { size: 14 }));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "archived-row-delete sidebar-rail-btn";
    deleteBtn.dataset.workspaceId = item.id;
    if (item.hasActiveSessions) {
      deleteBtn.title = "Delete archived tasks";
      deleteBtn.setAttribute("aria-label", "Delete archived tasks");
    } else {
      deleteBtn.title = "Delete workspace";
      deleteBtn.setAttribute("aria-label", "Delete workspace");
    }
    deleteBtn.append(createLucideIcon(Trash2, { size: 14 }));

    const actions = document.createElement("span");
    actions.className = "archived-row-actions";
    actions.append(unarchiveBtn, deleteBtn);

    row.append(toggle, actions);

    const sessionList = document.createElement("div");
    sessionList.className = "archived-sessions";
    for (const session of item.sessions) {
      sessionList.append(this.createSessionRow(session));
    }

    group.append(row, sessionList);
    this.applyGroupCollapsed(group, this.collapsedWorkspaceIds.has(item.id));
    return group;
  }

  private createSessionRow(session: ArchivedSessionItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "archived-session-row";
    row.dataset.sessionId = session.id;

    const title = document.createElement("span");
    title.className = "archived-session-title";
    title.textContent = session.title;
    title.title = session.title;

    const time = document.createElement("span");
    time.className = "archived-session-time";
    time.textContent = formatRelativeTime(session.updatedAt);

    const unarchiveBtn = document.createElement("button");
    unarchiveBtn.type = "button";
    unarchiveBtn.className = "archived-session-unarchive sidebar-rail-btn";
    unarchiveBtn.dataset.sessionId = session.id;
    unarchiveBtn.title = "Unarchive";
    unarchiveBtn.setAttribute("aria-label", "Unarchive task");
    unarchiveBtn.append(createLucideIcon(ArchiveRestore, { size: 14 }));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "archived-session-delete sidebar-rail-btn";
    deleteBtn.dataset.sessionId = session.id;
    deleteBtn.title = "Delete";
    deleteBtn.setAttribute("aria-label", "Delete task");
    deleteBtn.append(createLucideIcon(Trash2, { size: 14 }));

    row.append(title, time, unarchiveBtn, deleteBtn);
    return row;
  }

  private setGroupCollapsed(
    id: string,
    group: HTMLElement,
    collapsed: boolean,
  ): void {
    if (collapsed) {
      this.collapsedWorkspaceIds.add(id);
    } else {
      this.collapsedWorkspaceIds.delete(id);
    }
    this.applyGroupCollapsed(group, collapsed);
  }

  private applyGroupCollapsed(group: HTMLElement, collapsed: boolean): void {
    const wasCollapsed = group.dataset.collapsed === "1";
    group.dataset.collapsed = collapsed ? "1" : "0";
    group.classList.toggle("is-collapsed", collapsed);
    const toggle = group.querySelector(".archived-row-toggle");
    if (toggle instanceof HTMLElement) {
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    if (wasCollapsed && !collapsed) this.revealSessionRows(group);
  }

  /** One-shot staggered slide+fade mirroring the Projects tree. */
  private revealSessionRows(group: HTMLElement): void {
    const list = group.querySelector<HTMLElement>(".archived-sessions");
    if (!list) return;
    const rows = list.querySelectorAll<HTMLElement>(".archived-session-row");
    if (rows.length === 0) return;
    const stepMs = Math.min(28, Math.max(12, 160 / rows.length));
    rows.forEach((row, index) => {
      row.style.setProperty("--reveal-delay", `${Math.round(index * stepMs)}ms`);
    });
    list.classList.remove("is-revealing");
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

  onBackClick(handler: () => void): void {
    this.onBack = handler;
  }

  onUnarchiveClick(handler: (workspaceId: string) => void): void {
    this.onUnarchive = handler;
  }

  onDeleteClick(handler: (workspaceId: string) => void): void {
    this.onDelete = handler;
  }

  onSessionUnarchiveClick(handler: (sessionId: string) => void): void {
    this.onSessionUnarchive = handler;
  }

  onSessionDeleteClick(handler: (sessionId: string) => void): void {
    this.onSessionDelete = handler;
  }
}
