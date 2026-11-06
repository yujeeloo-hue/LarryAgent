/**
 * Dev Mode workbench DOM (plan: dev-mode-v1). Occupies the shell main slot:
 *
 *   [ editorPane | chatSplitter | chatPane ]
 *
 * The left Solution Outline mounts into the shell *sidebar* slot (the shell's
 * own resize handle sits between them). s6 fills the outline, s7 the editor
 * pane (Monaco tabs); this skeleton ships the chat pane + splitter.
 */
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  createLucideIcon,
  MessageSquare,
  PanelRightClose,
  Plus,
} from "../ui/originalIcons.js";
import "./devmode.css";
import { createDevModeIcon } from "./launchIcon.js";

export class WorkbenchView {
  readonly root: HTMLElement;
  /** Center column host — the EditorArea owns its content (s7). */
  readonly editorPane: HTMLElement;
  readonly chatSplitter: HTMLElement;
  readonly chatPane: HTMLElement;
  readonly chatHeader: HTMLElement;
  /** Becomes the session dropdown trigger in s8. */
  readonly chatTitleButton: HTMLButtonElement;
  readonly chatTitleText: HTMLElement;
  /** Header "+" — starts a New Task pinned to the active workspace. */
  readonly chatNewSessionButton: HTMLButtonElement;
  /** Collapses the chat pane (editor takes the full width). */
  readonly chatCollapseButton: HTMLButtonElement;
  /** Right-edge rail that brings the chat pane back when collapsed. */
  readonly chatExpandButton: HTMLButtonElement;
  readonly chatHost: HTMLElement;
  readonly chatEmpty: HTMLElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "devmode-workbench";

    // ------------------------------------------------------------- center
    this.editorPane = document.createElement("div");
    this.editorPane.className = "devmode-editor-pane";

    // ----------------------------------------------------------- splitter
    this.chatSplitter = document.createElement("div");
    this.chatSplitter.className = "devmode-chat-split";
    this.chatSplitter.setAttribute("role", "separator");
    this.chatSplitter.setAttribute("aria-orientation", "vertical");
    this.chatSplitter.setAttribute("aria-label", "Resize chat panel");
    this.chatSplitter.title = "Drag to resize";
    this.chatSplitter.tabIndex = 0;

    // -------------------------------------------------------------- right
    this.chatPane = document.createElement("div");
    this.chatPane.className = "devmode-chat-pane";

    this.chatHeader = document.createElement("div");
    this.chatHeader.className = "devmode-chat-header";

    this.chatTitleButton = document.createElement("button");
    this.chatTitleButton.type = "button";
    this.chatTitleButton.className = "devmode-chat-title";
    this.chatTitleButton.title = "Session";
    this.chatTitleText = document.createElement("span");
    this.chatTitleText.className = "devmode-chat-title-text";
    this.chatTitleText.textContent = "No session";
    // Chevron leads the title (dropdown affordance on the left edge).
    this.chatTitleButton.append(
      createLucideIcon(ChevronDown, { size: 13 }),
      this.chatTitleText,
    );

    this.chatNewSessionButton = document.createElement("button");
    this.chatNewSessionButton.type = "button";
    this.chatNewSessionButton.className = "devmode-chat-toggle";
    this.chatNewSessionButton.setAttribute("aria-label", "New Session");
    this.chatNewSessionButton.title = "New Session";
    this.chatNewSessionButton.append(createLucideIcon(Plus, { size: 14 }));

    this.chatCollapseButton = document.createElement("button");
    this.chatCollapseButton.type = "button";
    this.chatCollapseButton.className = "devmode-chat-toggle";
    this.chatCollapseButton.setAttribute("aria-label", "Collapse chat panel");
    this.chatCollapseButton.title = "Collapse chat panel";
    this.chatCollapseButton.append(
      createLucideIcon(PanelRightClose, { size: 14 }),
    );

    this.chatHeader.append(
      this.chatTitleButton,
      this.chatNewSessionButton,
      this.chatCollapseButton,
    );

    this.chatHost = document.createElement("div");
    this.chatHost.className = "devmode-chat-body";
    this.chatHost.hidden = true;

    this.chatEmpty = document.createElement("div");
    this.chatEmpty.className = "devmode-chat-empty";
    const chatIcon = createLucideIcon(MessageSquare, { size: 22 });
    chatIcon.classList.add("devmode-empty-icon");
    const chatHint = document.createElement("div");
    chatHint.textContent = "No session open";
    const chatSub = document.createElement("div");
    chatSub.className = "devmode-empty-hint";
    chatSub.textContent =
      "Start a task or pick a session from the dropdown after opening one.";
    this.chatEmpty.append(chatIcon, chatHint, chatSub);

    this.chatPane.append(this.chatHeader, this.chatHost, this.chatEmpty);

    // Collapsed-mode expand control — rides the merged launch pill's right
    // end as an animated segment once DevModeController mounts it.
    this.chatExpandButton = document.createElement("button");
    this.chatExpandButton.type = "button";
    this.chatExpandButton.className = "devmode-launch-btn devmode-chat-expand";
    this.chatExpandButton.setAttribute("aria-label", "Expand chat panel");
    this.chatExpandButton.title = "Expand chat panel";
    this.chatExpandButton.setAttribute("aria-hidden", "true");
    this.chatExpandButton.append(createDevModeIcon("chat"));
    this.chatExpandButton.tabIndex = -1;

    this.root.append(
      this.editorPane,
      this.chatSplitter,
      this.chatPane,
    );
  }

  /** Collapse the chat pane (editor spans full width; rail stays). */
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

  /** Splitter width feedback (px) — applied as a CSS var on the workbench. */
  setChatWidth(px: number): void {
    this.root.style.setProperty("--devmode-chat-width", `${Math.round(px)}px`);
    this.chatSplitter.setAttribute("aria-valuenow", String(Math.round(px)));
  }

  setChatDragging(dragging: boolean): void {
    this.chatSplitter.classList.toggle("is-dragging", dragging);
    this.root.classList.toggle("is-chat-resizing", dragging);
  }
}
