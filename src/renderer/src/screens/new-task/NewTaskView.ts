import { ChevronDown, Folder, Plus } from "lucide";
import { TaskComposerView } from "../../ui/taskComposer/TaskComposerView.js";
import { createLucideIcon } from "../../ui/icons.js";
import { createLucideIcon as createOriginalIcon } from "../../ui/originalIcons.js";
import appIconUrl from "../../assets/app-icon.png";
import "./new-task.css";

export type NewTaskWorkspaceOption = {
  id: string;
  name: string;
  path: string;
};

export class NewTaskView {
  readonly root: HTMLElement;
  readonly composer: TaskComposerView;
  readonly textarea: HTMLTextAreaElement;
  readonly plusButton: HTMLButtonElement;
  readonly imagesButton: HTMLButtonElement;
  readonly attachmentsButton: HTMLButtonElement;
  readonly sendButton: HTMLButtonElement;
  readonly workspaceButton: HTMLButtonElement;
  readonly workspaceMenu: HTMLElement;

  private menuOpen = false;
  private menuCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private workspaces: NewTaskWorkspaceOption[] = [];
  private selectedWorkspaceId: string | null = null;
  private onSelectWorkspace: ((workspaceId: string) => void) | null = null;
  private onCreateWorkspace: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "screen new-task-screen";

    const hero = document.createElement("div");
    hero.className = "welcome-hero";
    hero.innerHTML = `
      <h1 class="welcome-title">What should we work on?</h1>
    `;

    const heroIcon = document.createElement("img");
    heroIcon.className = "welcome-hero-icon";
    heroIcon.src = appIconUrl;
    heroIcon.alt = "";
    heroIcon.draggable = false;
    hero.prepend(heroIcon);

    const workspaceBar = document.createElement("div");
    workspaceBar.className = "new-task-workspace-bar";

    this.workspaceButton = document.createElement("button");
    this.workspaceButton.type = "button";
    this.workspaceButton.className = "new-task-workspace-btn";
    this.workspaceButton.setAttribute("aria-expanded", "false");
    this.workspaceButton.setAttribute("aria-haspopup", "listbox");

    const wsIcon = document.createElement("span");
    wsIcon.className = "new-task-workspace-icon";
    wsIcon.append(createOriginalIcon(Folder, { size: 14 }));

    const wsLabel = document.createElement("span");
    wsLabel.className = "new-task-workspace-label";
    wsLabel.textContent = "Workspace";

    const wsName = document.createElement("span");
    wsName.className = "new-task-workspace-name";
    wsName.textContent = "Loading…";

    const wsChevron = document.createElement("span");
    wsChevron.className = "new-task-workspace-chevron";
    wsChevron.setAttribute("aria-hidden", "true");
    wsChevron.append(createLucideIcon(ChevronDown, { size: 14 }));

    this.workspaceButton.append(wsIcon, wsLabel, wsName, wsChevron);

    this.workspaceMenu = document.createElement("div");
    this.workspaceMenu.className = "new-task-workspace-menu";
    this.workspaceMenu.hidden = true;
    this.workspaceMenu.setAttribute("role", "listbox");
    this.workspaceMenu.setAttribute("aria-label", "Workspaces");

    workspaceBar.append(this.workspaceButton, this.workspaceMenu);

    this.composer = new TaskComposerView({
      placeholder: "Ask to build, fix, or explore… (⌥⌃ for voice)",
      ariaLabel: "New task prompt",
      className: "task-composer-compact",
      rows: 1,
    });
    this.textarea = this.composer.textarea;
    this.plusButton = this.composer.plusButton;
    this.imagesButton = this.composer.imagesButton;
    this.attachmentsButton = this.composer.attachmentsButton;
    this.sendButton = this.composer.sendButton;

    this.root.append(hero, workspaceBar, this.composer.root);
  }

  setOnSelectWorkspace(handler: ((workspaceId: string) => void) | null): void {
    this.onSelectWorkspace = handler;
  }

  setOnCreateWorkspace(handler: (() => void) | null): void {
    this.onCreateWorkspace = handler;
  }

  setWorkspaces(
    workspaces: readonly NewTaskWorkspaceOption[],
    selectedId: string | null,
  ): void {
    this.workspaces = [...workspaces];
    this.selectedWorkspaceId = selectedId;
    const selected =
      workspaces.find((w) => w.id === selectedId) ?? workspaces[0] ?? null;
    this.setWorkspaceName(selected?.name ?? "No workspace");
    this.renderMenu();
  }

  setWorkspacePickerVisible(visible: boolean): void {
    if (this.workspaceButton.parentElement) this.workspaceButton.parentElement.hidden = !visible;
    if (!visible && this.menuOpen) this.setWorkspaceMenuOpen(false);
  }

  setWorkspaceName(name: string): void {
    const el = this.workspaceButton.querySelector(".new-task-workspace-name");
    if (el) el.textContent = name || "No workspace";
  }

  setWorkspaceMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.workspaceButton.setAttribute("aria-expanded", open ? "true" : "false");
    this.workspaceButton.classList.toggle("is-open", open);
    if (open) {
      if (this.menuCloseTimer !== null) {
        clearTimeout(this.menuCloseTimer);
        this.menuCloseTimer = null;
      }
      this.renderMenu();
      this.workspaceMenu.hidden = false;
      // Force a reflow so the enter transition starts from the closed state.
      void this.workspaceMenu.offsetWidth;
      this.workspaceMenu.classList.add("is-open");
    } else {
      this.workspaceMenu.classList.remove("is-open");
      if (this.menuCloseTimer === null) {
        this.menuCloseTimer = setTimeout(() => {
          this.menuCloseTimer = null;
          this.workspaceMenu.hidden = true;
        }, 180);
      }
    }
  }

  isWorkspaceMenuOpen(): boolean {
    return this.menuOpen;
  }

  setActionsExpanded(expanded: boolean): void {
    this.composer.setPlusMenuOpen(expanded);
  }

  setOnRunModeSelect(
    handler: ((
      mode: import("../../ui/taskComposer/TaskComposerView.js").ComposerRunMode,
    ) => void) | null,
  ): void {
    this.composer.setOnRunModeSelect(handler);
  }

  setOnCustomGraphSelect(
    handler: ((graph: { id: string; name: string }) => void) | null,
  ): void {
    this.composer.setOnCustomGraphSelect(handler);
  }

  setCustomGraphSelection(
    graph:
      | { id: string; name: string; color?: string | null | undefined }
      | null,
  ): void {
    this.composer.setCustomGraphSelection(graph);
  }

  setOnInfiniteSelect(
    handler: ((enabled: boolean) => void) | null,
  ): void {
    this.composer.setOnInfiniteSelect(handler);
  }

  setInfiniteEnabled(enabled: boolean): void {
    this.composer.setInfiniteEnabled(enabled);
  }

  setOnPermissionsSelect(
    handler: ((fullPermissions: boolean) => void) | null,
  ): void {
    this.composer.setOnPermissionsSelect(handler);
  }

  setOnAutoSkillSummarizeSelect(
    handler: ((enabled: boolean) => void) | null,
  ): void {
    this.composer.setOnAutoSkillSummarizeSelect(handler);
  }

  setPermissionsEnabled(enabled: boolean): void {
    this.composer.setPermissionsEnabled(enabled);
  }

  setAutoSkillSummarizeEnabled(enabled: boolean): void {
    this.composer.setAutoSkillSummarizeEnabled(enabled);
  }

  setComposerRunMode(
    mode: import("../../ui/taskComposer/TaskComposerView.js").ComposerRunMode,
  ): void {
    this.composer.setComposerRunMode(mode);
  }

  setReasoningEffort(
    level: import("../../ui/effortSeg/EffortSegView.js").ReasoningEffortLevel,
  ): void {
    this.composer.setReasoningEffort(level);
  }

  setOnReasoningEffortSelect(
    handler:
      | ((
          level: import("../../ui/effortSeg/EffortSegView.js").ReasoningEffortLevel,
        ) => void)
      | null,
  ): void {
    this.composer.setOnReasoningEffortSelect(handler);
  }

  /** @deprecated Prefer setComposerRunMode. */
  setPlanModeEnabled(enabled: boolean): void {
    this.composer.setComposerRunMode(enabled ? "plan" : "agent");
  }

  setSendEnabled(enabled: boolean): void {
    this.composer.setSendEnabled(enabled);
  }

  setContextUsage(
    usage: Parameters<TaskComposerView["setContextUsage"]>[0],
  ): void {
    this.composer.setContextUsage(usage);
  }

  getPrompt(): string {
    return this.composer.getPrompt();
  }

  clearPrompt(): void {
    this.composer.clearPrompt();
  }

  focusInput(): void {
    this.composer.focusInput();
  }

  private renderMenu(): void {
    this.workspaceMenu.replaceChildren();

    if (this.workspaces.length === 0) {
      const empty = document.createElement("p");
      empty.className = "new-task-workspace-menu-empty";
      empty.textContent = "No workspaces yet.";
      this.workspaceMenu.append(empty);
    } else {
      for (const workspace of this.workspaces) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "new-task-workspace-item";
        item.setAttribute("role", "option");
        item.dataset.workspaceId = workspace.id;
        const selected = workspace.id === this.selectedWorkspaceId;
        if (selected) {
          item.classList.add("is-active");
          item.setAttribute("aria-selected", "true");
        } else {
          item.setAttribute("aria-selected", "false");
        }

        const name = document.createElement("span");
        name.className = "new-task-workspace-item-name";
        name.textContent = workspace.name;

        const path = document.createElement("span");
        path.className = "new-task-workspace-item-path";
        path.textContent = workspace.path;
        path.title = workspace.path;

        item.append(name, path);
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          this.setWorkspaceMenuOpen(false);
          if (workspace.id !== this.selectedWorkspaceId) {
            this.onSelectWorkspace?.(workspace.id);
          }
        });
        this.workspaceMenu.append(item);
      }
    }

    const divider = document.createElement("div");
    divider.className = "new-task-workspace-menu-divider";
    divider.setAttribute("role", "separator");

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "new-task-workspace-item new-task-workspace-item-create action-primary";
    createBtn.setAttribute("role", "option");

    const createIcon = document.createElement("span");
    createIcon.className = "new-task-workspace-item-create-icon";
    createIcon.append(createOriginalIcon(Plus, { size: 14 }));

    const createLabel = document.createElement("span");
    createLabel.className = "new-task-workspace-item-name";
    createLabel.textContent = "New workspace…";

    createBtn.append(createIcon, createLabel);
    createBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setWorkspaceMenuOpen(false);
      this.onCreateWorkspace?.();
    });

    this.workspaceMenu.append(divider, createBtn);
  }
}
