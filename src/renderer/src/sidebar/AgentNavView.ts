import type { AgentNavId, AgentNavItem } from "../navigation/types.js";
import { createAgentNavIcon } from "./agentNavIcon.js";

export class AgentNavView {
  readonly root: HTMLElement;
  private readonly buttons = new Map<AgentNavId, HTMLButtonElement>();

  constructor(items: readonly AgentNavItem[]) {
    this.root = document.createElement("nav");
    this.root.className = "agent-nav";
    this.root.setAttribute("aria-label", "Agent");

    const list = document.createElement("div");
    list.className = "agent-nav-list";

    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-nav-item";
      button.dataset.navId = item.id;

      const iconWrap = createAgentNavIcon(item.id);

      const label = document.createElement("span");
      label.className = "agent-nav-label";
      label.textContent = item.label;

      button.append(iconWrap, label);
      this.buttons.set(item.id, button);
      list.append(button);
    }

    this.root.append(list);
  }

  setActive(id: AgentNavId | null): void {
    for (const [navId, button] of this.buttons) {
      const active = id !== null && navId === id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    }
  }

  onSelect(handler: (id: AgentNavId) => void): void {
    for (const [id, button] of this.buttons) {
      button.addEventListener("click", () => handler(id));
    }
  }
}
