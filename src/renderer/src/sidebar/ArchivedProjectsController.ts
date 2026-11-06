import {
  ArchivedProjectsView,
  type ArchivedProjectItem,
} from "./ArchivedProjectsView.js";

/** Archived Projects sidebar section controller. */
export class ArchivedProjectsController {
  private items: ArchivedProjectItem[] = [];
  private backHandler: (() => void) | undefined;
  private unarchiveHandler: ((workspaceId: string) => void) | undefined;
  private deleteHandler: ((workspaceId: string) => void) | undefined;
  private sessionUnarchiveHandler: ((sessionId: string) => void) | undefined;
  private sessionDeleteHandler: ((sessionId: string) => void) | undefined;

  constructor(private readonly view: ArchivedProjectsView) {
    this.view.onBackClick(() => this.backHandler?.());
    this.view.onUnarchiveClick((id) => this.unarchiveHandler?.(id));
    this.view.onDeleteClick((id) => this.deleteHandler?.(id));
    this.view.onSessionUnarchiveClick((id) => this.sessionUnarchiveHandler?.(id));
    this.view.onSessionDeleteClick((id) => this.sessionDeleteHandler?.(id));
    this.render();
  }

  mount(): HTMLElement {
    return this.view.root;
  }

  setItems(items: readonly ArchivedProjectItem[]): void {
    this.items = [...items];
    this.render();
  }

  private render(): void {
    this.view.render(this.items);
  }

  onBack(handler: () => void): void {
    this.backHandler = handler;
  }

  onUnarchive(handler: (workspaceId: string) => void): void {
    this.unarchiveHandler = handler;
  }

  onDelete(handler: (workspaceId: string) => void): void {
    this.deleteHandler = handler;
  }

  onSessionUnarchive(handler: (sessionId: string) => void): void {
    this.sessionUnarchiveHandler = handler;
  }

  onSessionDelete(handler: (sessionId: string) => void): void {
    this.sessionDeleteHandler = handler;
  }
}

export function createArchivedProjectsSection(): ArchivedProjectsController {
  return new ArchivedProjectsController(new ArchivedProjectsView());
}
