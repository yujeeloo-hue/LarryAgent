import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  createLucideIcon,
  MessageSquare,
} from "../ui/originalIcons.js";
import "./devmode.css";
import { createDevModeIcon } from "./launchIcon.js";

export class WorkbenchView {
  readonly root: HTMLElement;
  readonly editorPane: HTMLElement;
  readonly chatSplitter: HTMLElement;
  readonly chatPane: HTMLElement;
  readonly chatHeader: HTMLElement;
  readonly chatTitleButton: HTMLButtonElement;
  readonly chatTitleText: HTMLElement;
  readonly chatNewSessionButton: HTMLButtonElement;
  readonly chatCollapseButton: HTMLButtonElement;
  readonly chatExpandButton: HTMLButtonElement;
  readonly chatHost: HTMLElement;
  readonly chatEmpty: HTMLElement;
  private readonly referenceStatus = document.createElement("div");

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "devmode-workbench";

    this.editorPane = document.createElement("div");
    this.editorPane.className = "devmode-editor-pane";

    this.chatSplitter = document.createElement("div");
    this.chatSplitter.className = "devmode-chat-split";
    this.chatSplitter.setAttribute("role", "separator");
    this.chatSplitter.setAttribute("aria-orientation", "vertical");
    this.chatSplitter.setAttribute("aria-label", "Resize chat panel");
    this.chatSplitter.title = "Drag to resize";
    this.chatSplitter.tabIndex = 0;

    this.chatPane = document.createElement("div");
    this.chatPane.className = "devmode-chat-pane";

    this.chatHeader = document.createElement("div");
    this.chatHeader.className = "devmode-chat-header";

    this.chatTitleButton = document.createElement("button");
    this.chatTitleButton.type = "button";
    this.chatTitleButton.className = "devmode-chat-title";
    this.chatTitleButton.title = "Task";
    this.chatTitleText = document.createElement("span");
    this.chatTitleText.className = "devmode-chat-title-text";
    this.chatTitleText.textContent = "No task";
    this.chatTitleButton.append(
      createLucideIcon(ChevronDown, { size: 13 }),
      this.chatTitleText,
    );

    this.chatNewSessionButton = document.createElement("button");
    this.chatNewSessionButton.type = "button";
    this.chatNewSessionButton.className = "devmode-launch-btn";
    this.chatNewSessionButton.setAttribute("aria-label", "New Task");
    this.chatNewSessionButton.title = "New Task";
    this.chatNewSessionButton.append(createDevModeIcon("new-task"));

    this.chatCollapseButton = document.createElement("button");
    this.chatCollapseButton.type = "button";
    this.chatCollapseButton.className = "devmode-launch-btn";
    this.chatCollapseButton.setAttribute("aria-label", "Collapse chat panel");
    this.chatCollapseButton.title = "Collapse chat panel";
    this.chatCollapseButton.append(
      createDevModeIcon("collapse-chat"),
    );

    const chatActions = document.createElement("div");
    chatActions.className = "devmode-launch-pill devmode-chat-actions";
    chatActions.setAttribute("role", "group");
    chatActions.setAttribute("aria-label", "Chat actions");
    chatActions.append(this.chatNewSessionButton, this.chatCollapseButton);

    this.chatHeader.append(
      this.chatTitleButton,
      chatActions,
    );

    this.chatHost = document.createElement("div");
    this.chatHost.className = "devmode-chat-body";
    this.chatHost.hidden = true;

    this.chatEmpty = document.createElement("div");
    this.chatEmpty.className = "devmode-chat-empty";
    const chatIcon = createLucideIcon(MessageSquare, { size: 22 });
    chatIcon.classList.add("devmode-empty-icon");
    const chatHint = document.createElement("div");
    chatHint.textContent = "No task open";
    const chatSub = document.createElement("div");
    chatSub.className = "devmode-empty-hint";
    chatSub.textContent =
      "Start a task or pick one from the task menu.";
    this.chatEmpty.append(chatIcon, chatHint, chatSub);

    this.chatPane.append(this.chatHeader, this.chatHost, this.chatEmpty);

    this.chatExpandButton = document.createElement("button");
    this.chatExpandButton.type = "button";
    this.chatExpandButton.className = "devmode-launch-btn devmode-chat-expand";
    this.chatExpandButton.setAttribute("aria-label", "Expand chat panel");
    this.chatExpandButton.title = "Expand chat panel";
    this.chatExpandButton.setAttribute("aria-hidden", "true");
    this.chatExpandButton.append(createDevModeIcon("chat"));
    this.chatExpandButton.tabIndex = -1;

    this.referenceStatus.className = "visually-hidden";
    this.referenceStatus.setAttribute("role", "status");
    this.root.append(
      this.editorPane,
      this.chatSplitter,
      this.chatPane,
      this.referenceStatus,
    );
  }

  announceFileReference(message: string): void {
    this.referenceStatus.textContent = message;
  }

  setChatCollapsed(collapsed: boolean): void {
    this.root.classList.toggle("is-chat-collapsed", collapsed);
    this.chatCollapseButton.setAttribute(
      "aria-expanded",
      collapsed ? "false" : "true",
    );
  }

  setChatTitle(title: string): void {
    this.chatTitleText.textContent = title;
    this.chatTitleButton.title = title;
  }



  setChatHasSession(has: boolean): void {
    this.chatHost.hidden = !has;
    this.chatEmpty.hidden = has;
  }

  setChatWidth(px: number): void {
    this.root.style.setProperty("--devmode-chat-width", `${Math.round(px)}px`);
    this.chatSplitter.setAttribute("aria-valuenow", String(Math.round(px)));
  }

  setChatDragging(dragging: boolean): void {
    this.chatSplitter.classList.toggle("is-dragging", dragging);
    this.root.classList.toggle("is-chat-resizing", dragging);
  }
}
