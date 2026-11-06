import type { AgentNavId } from "../navigation/types.js";
import type { AgentNavView } from "./AgentNavView.js";

export class AgentNavController {
  private active: AgentNavId | null = "new-task";
  private onChange: ((id: AgentNavId) => void) | undefined;

  constructor(private readonly view: AgentNavView) {
    this.view.setActive(this.active);
    this.view.onSelect((id) => this.select(id));
  }

  mount(): HTMLElement {
    return this.view.root;
  }

  getActive(): AgentNavId | null {
    return this.active;
  }

  select(id: AgentNavId): void {
    if (this.active === id) return;
    this.active = id;
    this.view.setActive(id);
    this.onChange?.(id);
  }

  /** Clear highlight when viewing a session (not a nav screen). */
  clearSelection(): void {
    if (this.active === null) return;
    this.active = null;
    this.view.setActive(null);
  }

  onSelectionChange(handler: (id: AgentNavId) => void): void {
    this.onChange = handler;
  }
}
