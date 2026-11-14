import { LogDrawerController } from "../log-drawer/LogDrawerController.js";
import { LogDrawerView } from "../log-drawer/LogDrawerView.js";
import { DevToolsView, type DevToolsTab } from "./DevToolsView.js";
import { FsmPaneController } from "./FsmPaneController.js";
import { FsmPaneView } from "./FsmPaneView.js";
import { ToolStatsPaneController } from "./ToolStatsPaneController.js";
import { ToolStatsPaneView } from "./ToolStatsPaneView.js";
import { TimelinePaneController } from "./TimelinePaneController.js";
import { TimelinePaneView } from "./TimelinePaneView.js";

/**
 * Detail drawer: Timeline + FSM + Log + Tool Stats tabs. (Terminal moved to
 * Dev Mode's editor column — see devmode/TerminalPaneController.)
 */
export class DevToolsController {
  private readonly view = new DevToolsView();
  private readonly fsm = new FsmPaneController(new FsmPaneView());
  private readonly logs = new LogDrawerController(new LogDrawerView());
  private readonly tools = new ToolStatsPaneController(new ToolStatsPaneView());
  private readonly timeline = new TimelinePaneController(
    new TimelinePaneView(),
  );
  private open = false;
  private sessionId: string | null = null;
  private closeHandler: (() => void) | undefined;
  private tabChangeHandler: ((tab: DevToolsTab) => void) | undefined;

  mount(): HTMLElement {
    this.view.fsmPaneHost.append(this.fsm.mount());
    this.view.logsPaneHost.append(this.logs.mount());
    this.view.toolsPaneHost.append(this.tools.mount());
    this.view.timelinePaneHost.append(this.timeline.mount());

    this.view.closeButton.addEventListener("click", () => {
      this.setOpen(false);
      this.closeHandler?.();
    });
    this.view.fsmTabButton.addEventListener("click", () => {
      this.setTab("fsm");
    });
    this.view.logsTabButton.addEventListener("click", () => {
      this.setTab("logs");
    });
    this.view.toolsTabButton.addEventListener("click", () => {
      this.setTab("tools");
    });
    this.view.timelineTabButton.addEventListener("click", () => {
      this.setTab("timeline");
    });

    return this.view.root;
  }

  destroy(): void {
    this.fsm.destroy();
    this.logs.destroy();
    this.tools.destroy();
    this.timeline.destroy();
    this.view.root.remove();
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onTabChange(handler: (tab: DevToolsTab) => void): void {
    this.tabChangeHandler = handler;
  }

  /** Timeline toolbar: cycle the drawer between its two heights. */
  onTimelinePanelHeightToggle(handler: () => void): void {
    this.timeline.onPanelHeightToggle(handler);
  }

  /** Timeline: a bar was clicked open — grow the drawer when too short. */
  onTimelineBarSelect(handler: () => void): void {
    this.timeline.onBarSelect(handler);
  }

  getActiveTab(): DevToolsTab {
    return this.view.getActiveTab();
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Focused conversation — drives the FSM, Tools, and Timeline tabs. */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.fsm.setSessionId(sessionId);
    this.tools.setSessionId(sessionId);
    this.timeline.setSessionId(sessionId);
    if (this.open) {
      const tab = this.view.getActiveTab();
      if (tab === "tools") {
        void this.tools.refresh();
      }
    }
  }

  /** Refresh the active pane when the focused session changes. */
  notifySessionUpdated(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    if (!this.open) return;
    const tab = this.view.getActiveTab();
    if (tab === "fsm") {
      void this.fsm.refresh();
    } else if (tab === "timeline") {
      void this.timeline.refresh();
    } else if (tab === "tools") {
      void this.tools.refresh();
    }
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.logs.setOpen(open && this.view.getActiveTab() === "logs");
    if (open && this.view.getActiveTab() === "tools") {
      void this.tools.refresh();
    }
    if (open && this.view.getActiveTab() === "fsm") {
      void this.fsm.refresh();
    }
    if (open && this.view.getActiveTab() === "timeline") {
      void this.timeline.refresh();
    }
    if (open) {
      this.tabChangeHandler?.(this.view.getActiveTab());
    }
  }

  private setTab(tab: DevToolsTab): void {
    this.view.setActiveTab(tab);
    this.tabChangeHandler?.(tab);
    if (!this.open) return;
    this.logs.setOpen(tab === "logs");
    if (tab === "tools") {
      void this.tools.refresh();
    }
    if (tab === "fsm") {
      void this.fsm.refresh();
    }
    if (tab === "timeline") {
      void this.timeline.refresh();
    }
  }
}
