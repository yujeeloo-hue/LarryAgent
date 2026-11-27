import type { AgentNavId } from "../navigation/types.js";
import type { AgentNavView } from "./AgentNavView.js";

export class AgentNavController {
  private active: AgentNavId | null = "new-task";
  private onChange: ((id: AgentNavId) => void) | undefined;

  constructor(
    private readonly view: AgentNavView,
    navigate: (update: () => void, shouldAnimate: () => boolean) => void,
  ) {
    this.view.setActive(this.active);
    this.view.onSelect((id) => {
      navigate(() => this.select(id), () => this.active !== id);
    });
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

  clearSelection(): void {
    if (this.active === null) return;
    this.active = null;
    this.view.setActive(null);
  }

  onSelectionChange(handler: (id: AgentNavId) => void): void {
    this.onChange = handler;
  }
}
