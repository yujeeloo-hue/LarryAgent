import { X, createLucideIcon } from "../ui/originalIcons.js";
import "./dev-tools.css";

export type DevToolsTab =
  | "fsm"
  | "logs"
  | "tools"
  | "timeline";

/** Bottom Detail drawer — Timeline, FSM, Log, and Tool Stats. */
export class DevToolsView {
  readonly root: HTMLElement;
  readonly closeButton: HTMLButtonElement;
  readonly fsmTabButton: HTMLButtonElement;
  readonly logsTabButton: HTMLButtonElement;
  readonly toolsTabButton: HTMLButtonElement;
  readonly timelineTabButton: HTMLButtonElement;
  readonly fsmPaneHost: HTMLElement;
  readonly logsPaneHost: HTMLElement;
  readonly toolsPaneHost: HTMLElement;
  readonly timelinePaneHost: HTMLElement;
  private activeTab: DevToolsTab = "timeline";

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "dev-tools";
    this.root.setAttribute("aria-label", "Detail");

    const chrome = document.createElement("div");
    chrome.className = "dev-tools-chrome";

    const tabs = document.createElement("div");
    tabs.className = "dev-tools-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Detail panels");

    this.fsmTabButton = document.createElement("button");
    this.fsmTabButton.type = "button";
    this.fsmTabButton.className = "dev-tools-tab";
    this.fsmTabButton.setAttribute("role", "tab");
    this.fsmTabButton.setAttribute("aria-selected", "false");
    this.fsmTabButton.dataset.tab = "fsm";
    this.fsmTabButton.textContent = "FSM";

    this.logsTabButton = document.createElement("button");
    this.logsTabButton.type = "button";
    this.logsTabButton.className = "dev-tools-tab";
    this.logsTabButton.setAttribute("role", "tab");
    this.logsTabButton.setAttribute("aria-selected", "false");
    this.logsTabButton.dataset.tab = "logs";
    this.logsTabButton.textContent = "Log";

    this.toolsTabButton = document.createElement("button");
    this.toolsTabButton.type = "button";
    this.toolsTabButton.className = "dev-tools-tab";
    this.toolsTabButton.setAttribute("role", "tab");
    this.toolsTabButton.setAttribute("aria-selected", "false");
    this.toolsTabButton.dataset.tab = "tools";
    this.toolsTabButton.textContent = "Tool Stats";

    this.timelineTabButton = document.createElement("button");
    this.timelineTabButton.type = "button";
    this.timelineTabButton.className = "dev-tools-tab is-active";
    this.timelineTabButton.setAttribute("role", "tab");
    this.timelineTabButton.setAttribute("aria-selected", "true");
    this.timelineTabButton.dataset.tab = "timeline";
    this.timelineTabButton.textContent = "Timeline";

    tabs.append(
      this.timelineTabButton,
      this.fsmTabButton,
      this.logsTabButton,
      this.toolsTabButton,
    );

    this.closeButton = document.createElement("button");
    this.closeButton.type = "button";
    this.closeButton.className = "dev-tools-close";
    this.closeButton.setAttribute("aria-label", "Close");
    this.closeButton.title = "Close";
    this.closeButton.append(createLucideIcon(X, { size: 14 }));

    chrome.append(tabs, this.closeButton);

    this.fsmPaneHost = document.createElement("div");
    this.fsmPaneHost.className = "dev-tools-pane";
    this.fsmPaneHost.dataset.pane = "fsm";
    this.fsmPaneHost.setAttribute("role", "tabpanel");
    this.fsmPaneHost.hidden = true;

    this.logsPaneHost = document.createElement("div");
    this.logsPaneHost.className = "dev-tools-pane";
    this.logsPaneHost.dataset.pane = "logs";
    this.logsPaneHost.setAttribute("role", "tabpanel");
    this.logsPaneHost.hidden = true;

    this.toolsPaneHost = document.createElement("div");
    this.toolsPaneHost.className = "dev-tools-pane";
    this.toolsPaneHost.dataset.pane = "tools";
    this.toolsPaneHost.setAttribute("role", "tabpanel");
    this.toolsPaneHost.hidden = true;

    this.timelinePaneHost = document.createElement("div");
    this.timelinePaneHost.className = "dev-tools-pane";
    this.timelinePaneHost.classList.add("is-active");
    this.timelinePaneHost.dataset.pane = "timeline";
    this.timelinePaneHost.setAttribute("role", "tabpanel");

    this.root.append(
      chrome,
      this.fsmPaneHost,
      this.logsPaneHost,
      this.toolsPaneHost,
      this.timelinePaneHost,
    );
  }

  setActiveTab(tab: DevToolsTab): void {
    this.activeTab = tab;
    const panes: Array<{
      tab: DevToolsTab;
      button: HTMLButtonElement;
      host: HTMLElement;
    }> = [
      { tab: "fsm", button: this.fsmTabButton, host: this.fsmPaneHost },
      { tab: "logs", button: this.logsTabButton, host: this.logsPaneHost },
      { tab: "tools", button: this.toolsTabButton, host: this.toolsPaneHost },
      {
        tab: "timeline",
        button: this.timelineTabButton,
        host: this.timelinePaneHost,
      },
    ];
    for (const pane of panes) {
      const active = pane.tab === tab;
      pane.button.classList.toggle("is-active", active);
      pane.button.setAttribute("aria-selected", active ? "true" : "false");
      pane.host.classList.toggle("is-active", active);
      pane.host.hidden = !active;
    }
  }

  getActiveTab(): DevToolsTab {
    return this.activeTab;
  }
}
