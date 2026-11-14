import { Archive, Check, ChevronDown, Trash2, createLucideIcon } from "../ui/originalIcons.js";
import { computeSessionSortKeys, sortSessionsByKeys } from "../sidebar/sessionSortKeys.js";
import { readLastDevModeTask, writeLastDevModeTask } from "./DevModeState.js";
import { createDevModeIcon } from "./launchIcon.js";
import type { WorkbenchView } from "./WorkbenchView.js";

type Workspace = { id: string; name: string; path: string };
type Task = { id: string; title: string; status?: string; updatedAt: number };
type NavigationDeps = {
  getWorkspaces: () => Workspace[];
  getWorkspaceSessions: (workspaceId: string) => Task[];
  onWorkspaceSelected: (workspaceId: string) => void;
  onCreateWorkspace: (anchor: HTMLButtonElement) => void;
  onOpenSession: (sessionId: string) => void;
  onNewTask: () => void;
  onArchiveSession?: ((sessionId: string) => void) | undefined;
  onDeleteSession?: ((sessionId: string) => void) | undefined;
};

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

let nextMenuId = 0;

/** Workspace navigation stays in the tree; the chat menu contains only its tasks. */
export class DevModeNavigationController {
  readonly workspaceHeader = document.createElement("div");
  readonly workspaceButton = document.createElement("button");
  readonly workspaceCreateButton = document.createElement("button");
  readonly workspaceActions = document.createElement("div");
  private readonly workspaceLabel = document.createElement("span");
  private readonly workspaceMenuId = `devmode-workspaces-${++nextMenuId}`;
  private readonly taskMenuId = `devmode-tasks-${nextMenuId}`;
  private workspacePath: string | null = null;
  private sessionId: string | null = null;
  private menu: HTMLElement | null = null;
  private menuKind: "workspace" | "task" | null = null;
  private sortKeys = new Map<string, number>();
  private readonly rememberedTasks = new Map<string, string | null>();

  constructor(
    private readonly view: Pick<WorkbenchView, "chatTitleButton" | "chatPane">,
    private readonly deps: NavigationDeps,
  ) {
    this.workspaceHeader.className = "devmode-workspace-header";
    this.workspaceButton.type = "button";
    this.workspaceButton.className = "devmode-chat-title devmode-workspace-trigger";
    this.workspaceButton.setAttribute("aria-label", "Switch workspace");
    this.workspaceButton.setAttribute("aria-haspopup", "menu");
    this.workspaceButton.setAttribute("aria-expanded", "false");
    this.workspaceButton.setAttribute("aria-controls", this.workspaceMenuId);
    this.workspaceLabel.className = "devmode-chat-title-text";
    this.workspaceButton.append(
      createLucideIcon(ChevronDown, { size: 12 }), this.workspaceLabel,
    );
    this.workspaceActions.className = "devmode-launch-pill";
    this.workspaceCreateButton.type = "button";
    this.workspaceCreateButton.className = "devmode-launch-btn devmode-workspace-create";
    this.workspaceCreateButton.title = "New workspace";
    this.workspaceCreateButton.setAttribute("aria-label", "New workspace");
    this.workspaceCreateButton.setAttribute("aria-haspopup", "menu");
    this.workspaceCreateButton.append(createDevModeIcon("new-task"));
    this.workspaceActions.append(this.workspaceCreateButton);
    this.workspaceHeader.append(this.workspaceButton, this.workspaceActions);
    this.view.chatTitleButton.setAttribute("aria-haspopup", "menu");
    this.view.chatTitleButton.setAttribute("aria-expanded", "false");
    this.view.chatTitleButton.setAttribute("aria-controls", this.taskMenuId);
    this.workspaceButton.addEventListener("click", this.toggleWorkspaces);
    this.workspaceCreateButton.addEventListener("click", this.createWorkspace);
    this.workspaceActions.addEventListener("click", this.workspaceActionClicked);
    this.view.chatTitleButton.addEventListener("click", this.toggleTasks);
    this.refresh();
  }

  get workspace(): Workspace | undefined {
    return this.workspacePath === null ? undefined : this.deps.getWorkspaces().find(
      (workspace) => pathKey(workspace.path) === pathKey(this.workspacePath!),
    );
  }

  setContext(path: string | null, sessionId: string | null): void {
    const changed = path !== this.workspacePath || sessionId !== this.sessionId;
    if (changed) this.closeMenus();
    this.workspacePath = path;
    this.sessionId = sessionId;
    const workspace = this.workspace;
    if (workspace && changed) {
      this.rememberedTasks.set(workspace.id, sessionId);
      writeLastDevModeTask(workspace.id, sessionId);
    }
    this.refresh();
  }

  /** Ignore an archived/deleted remembered task and fall back to the newest one. */
  taskForWorkspace(workspaceId: string): string | null {
    const remembered = this.rememberedTasks.has(workspaceId)
      ? this.rememberedTasks.get(workspaceId)
      : readLastDevModeTask(workspaceId);
    if (remembered === null) return null;
    const tasks = this.deps.getWorkspaceSessions(workspaceId);
    return tasks.find((task) => task.id === remembered)?.id ?? tasks[0]?.id ?? null;
  }

  refresh(): void {
    const workspace = this.workspace;
    this.workspaceLabel.textContent = workspace?.name ?? "Workspace";
    this.workspaceButton.title = workspace?.path ?? "Switch workspace";
    this.workspaceButton.setAttribute("aria-label", workspace ? `Switch workspace: ${workspace.name}` : "Switch workspace");
    if (!this.menu) return;
    const focused = this.menu.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusKey = focused?.dataset.navigationKey;
    this.renderMenu();
    if (focusKey) this.menu.querySelectorAll<HTMLElement>("[data-navigation-key]").forEach((item) => {
      if (item.dataset.navigationKey === focusKey) item.focus();
    });
    if (this.menuKind === "workspace") this.positionWorkspaceMenu();
  }

  closeMenus(restoreFocus = false): void {
    const trigger = this.menuKind === "workspace" ? this.workspaceButton : this.view.chatTitleButton;
    this.menu?.remove();
    this.menu = null;
    this.menuKind = null;
    this.workspaceButton.setAttribute("aria-expanded", "false");
    this.view.chatTitleButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.outsidePointer, true);
    document.removeEventListener("keydown", this.menuKeydown, true);
    window.removeEventListener("blur", this.viewportChanged);
    window.removeEventListener("resize", this.viewportChanged);
    document.removeEventListener("scroll", this.scrolled, true);
    if (restoreFocus) trigger.focus();
  }

  destroy(): void {
    this.closeMenus();
    this.workspaceButton.removeEventListener("click", this.toggleWorkspaces);
    this.workspaceCreateButton.removeEventListener("click", this.createWorkspace);
    this.workspaceActions.removeEventListener("click", this.workspaceActionClicked);
    this.view.chatTitleButton.removeEventListener("click", this.toggleTasks);
    this.workspaceHeader.remove();
  }

  private readonly toggleWorkspaces = (): void => this.toggle("workspace");
  private readonly workspaceActionClicked = (): void => this.closeMenus();
  private readonly createWorkspace = (): void => {
    this.closeMenus();
    this.deps.onCreateWorkspace(this.workspaceCreateButton);
  };
  private readonly toggleTasks = (): void => this.toggle("task");
  private readonly viewportChanged = (): void => this.closeMenus();
  private readonly scrolled = (event: Event): void => {
    if (!(event.target instanceof Node) || !this.menu?.contains(event.target)) this.closeMenus();
  };
  private readonly outsidePointer = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node) || this.menu?.contains(target) || this.workspaceButton.contains(target) || this.view.chatTitleButton.contains(target)) return;
    this.closeMenus();
  };
  private readonly menuKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") { this.closeMenus(true); return; }
    if (!this.menu?.contains(document.activeElement) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...this.menu.querySelectorAll<HTMLElement>("[data-navigation-key]")];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };

  private toggle(kind: "workspace" | "task"): void {
    if (this.menuKind === kind) { this.closeMenus(); return; }
    this.closeMenus();
    this.menuKind = kind;
    this.menu = document.createElement("div");
    this.menu.id = kind === "workspace" ? this.workspaceMenuId : this.taskMenuId;
    this.menu.className = `devmode-session-menu${kind === "workspace" ? " devmode-workspace-menu" : ""}`;
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("aria-label", kind === "workspace" ? "Workspaces" : "Tasks");
    this.renderMenu();
    (kind === "workspace" ? document.body : this.view.chatPane).append(this.menu);
    const trigger = kind === "workspace" ? this.workspaceButton : this.view.chatTitleButton;
    trigger.setAttribute("aria-expanded", "true");
    if (kind === "workspace") this.positionWorkspaceMenu();
    document.addEventListener("pointerdown", this.outsidePointer, true);
    document.addEventListener("keydown", this.menuKeydown, true);
    window.addEventListener("blur", this.viewportChanged);
    window.addEventListener("resize", this.viewportChanged);
    document.addEventListener("scroll", this.scrolled, true);
    (this.menu.querySelector<HTMLElement>(".is-active[data-navigation-key]") ?? this.menu.querySelector<HTMLElement>("[data-navigation-key]"))?.focus();
  }

  private positionWorkspaceMenu(): void {
    if (!this.menu) return;
    const anchor = this.workspaceHeader.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 16);
    this.menu.style.width = `${width}px`;
    this.menu.style.maxHeight = `${Math.max(80, window.innerHeight - anchor.bottom - 16)}px`;
    const height = this.menu.getBoundingClientRect().height;
    this.menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - height - 8))}px`;
  }

  private heading(text: string): void {
    const heading = document.createElement("div");
    heading.className = "devmode-switcher-heading";
    heading.textContent = text;
    this.menu!.append(heading);
  }

  private empty(text: string): void {
    const empty = document.createElement("div");
    empty.className = "devmode-session-menu-empty";
    empty.textContent = text;
    this.menu!.append(empty);
  }

  private renderMenu(): void {
    this.menu!.replaceChildren();
    if (this.menuKind === "workspace") {
      this.heading("Workspaces");
      const workspaces = this.deps.getWorkspaces();
      if (!workspaces.length) this.empty("No workspaces yet — use + to create one");
      for (const workspace of workspaces) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "devmode-session-item devmode-workspace-item";
        const active = workspace.id === this.workspace?.id;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-current", String(active));
        item.setAttribute("role", "menuitem");
        item.dataset.workspaceId = workspace.id;
        item.dataset.navigationKey = workspace.id;
        item.title = workspace.path;
        const copy = document.createElement("span");
        copy.className = "devmode-workspace-copy";
        const name = document.createElement("span");
        name.textContent = workspace.name;
        const path = document.createElement("span");
        path.className = "devmode-workspace-path";
        path.textContent = workspace.path;
        copy.append(name, path);
        item.append(copy);
        if (active) item.append(createLucideIcon(Check, { size: 12 }));
        item.addEventListener("click", () => {
          this.closeMenus();
          if (!active) this.deps.onWorkspaceSelected(workspace.id);
        });
        this.menu!.append(item);
      }
      return;
    }
    const workspace = this.workspace;
    if (!workspace) { this.empty("Choose a workspace from the file tree"); return; }
    this.heading(`${workspace.name} · Tasks`);
    const tasks = [...this.deps.getWorkspaceSessions(workspace.id)];
    this.sortKeys = computeSessionSortKeys(tasks, this.sortKeys);
    sortSessionsByKeys(tasks, this.sortKeys);
    if (!tasks.length) this.empty("No tasks yet");
    for (const task of tasks) this.menu!.append(this.taskRow(task));
    const divider = document.createElement("div");
    divider.className = "devmode-switcher-divider";
    divider.setAttribute("role", "separator");
    const create = document.createElement("button");
    create.type = "button";
    create.className = "devmode-session-item devmode-task-new";
    create.setAttribute("role", "menuitem");
    create.dataset.navigationKey = "new-task";
    create.append(createDevModeIcon("new-task"), document.createTextNode("New Task"));
    create.addEventListener("click", () => { this.closeMenus(); this.deps.onNewTask(); });
    this.menu!.append(divider, create);
  }

  private taskRow(task: Task): HTMLElement {
    const running = task.status === "running";
    const item = document.createElement("div");
    item.className = "devmode-session-item";
    item.classList.toggle("is-active", task.id === this.sessionId);
    item.classList.toggle("is-running", running);
    item.setAttribute("role", "menuitem");
    item.tabIndex = 0;
    item.title = task.title;
    item.dataset.sessionId = task.id;
    item.dataset.navigationKey = task.id;
    const label = document.createElement("span");
    label.className = "devmode-session-item-label";
    label.textContent = task.title;
    item.append(label);
    const open = (): void => {
      this.closeMenus();
      if (task.id !== this.sessionId) this.deps.onOpenSession(task.id);
    };
    item.addEventListener("click", (event) => {
      if ((event.target as Element).closest("button")) return;
      open();
    });
    item.addEventListener("keydown", (event) => {
      if (event.target !== item || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault(); open();
    });
    for (const action of ["delete", "archive"] as const) {
      const handler = action === "delete" ? this.deps.onDeleteSession : this.deps.onArchiveSession;
      if (!handler) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `devmode-session-item-${action}`;
      button.dataset.sessionId = task.id;
      button.disabled = running;
      button.title = running ? `Stop the task before ${action === "delete" ? "deleting" : "archiving"}` : action === "delete" ? "Delete task" : "Archive task";
      button.setAttribute("aria-label", action === "delete" ? "Delete task" : "Archive task");
      button.append(createLucideIcon(action === "delete" ? Trash2 : Archive, { size: 13 }));
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (running) return;
        this.closeMenus(); handler(task.id);
      });
      item.append(button);
    }
    if (running) {
      const spinner = document.createElement("span");
      spinner.className = "session-running-spinner";
      spinner.setAttribute("aria-label", "Running");
      spinner.setAttribute("role", "status");
      item.append(spinner);
    }
    return item;
  }
}
