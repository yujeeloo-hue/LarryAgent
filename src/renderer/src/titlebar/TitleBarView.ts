import {
  Copy,
  Minus,
  X,
  createLucideIcon,
  createFunctionalIcon,
} from "../ui/icons.js";
import { createAppBrandIcon } from "../ui/appBrandIcon.js";
import { createMonoIcon } from "../ui/monoIcon.js";

export interface WindowControlsHandlers {
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export class TitleBarView {
  readonly root: HTMLElement;
  /** Dev Mode toggle → three-column workbench (plan: dev-mode-v1). */
  readonly devModeButton: HTMLButtonElement;
  /** Remote relay indicator → web console shortcut (same chrome as Detail). */
  readonly remoteConsoleButton: HTMLButtonElement;
  /** Notification bell (message center) — beside the relay indicator. */
  readonly bellButton: HTMLButtonElement;
  readonly logsButton: HTMLButtonElement;
  readonly settingsButton: HTMLButtonElement;

  private readonly actions: HTMLElement;
  private captionGroup: HTMLElement | undefined;
  private maximizeButton: HTMLButtonElement | undefined;
  private maximizeGlyphMax: SVGElement | undefined;
  private maximizeGlyphRestore: SVGElement | undefined;
  private readonly bellBadge: HTMLElement;

  constructor() {
    this.root = document.createElement("header");
    this.root.className = "title-bar";
    this.root.setAttribute("role", "banner");

    const drag = document.createElement("div");
    drag.className = "title-bar-drag";
    drag.dataset.region = "drag";

    // Dev Mode hides the sidebar (and its app name) behind the Solution
    // Outline, so Windows gets the brand mark here instead — CSS keeps it
    // to win32 + Dev Mode, where the title bar owns the window's top-left.
    // 16px icon + name (approved option A, scripts/titlebar-brand-icon-
    // demo.html); macOS stays text-free for the traffic-light corner.
    const brand = document.createElement("div");
    brand.className = "title-bar-brand";
    const brandIcon = createAppBrandIcon();
    const appName = document.createElement("span");
    appName.className = "title-bar-app-name";
    appName.textContent = window.jellybot?.appName || "Larry Agent";
    brand.append(brandIcon, appName);
    drag.append(brand);

    this.actions = document.createElement("div");
    this.actions.className = "title-bar-actions";

    // Dev Mode toggle (plan decision #3): leftmost action; per-workspace
    // memory lives in DevModeState, the shell owns enter/exit.
    this.devModeButton = document.createElement("button");
    this.devModeButton.type = "button";
    this.devModeButton.className = "title-bar-btn";
    this.devModeButton.setAttribute("aria-label", "Dev Mode");
    this.devModeButton.setAttribute("aria-pressed", "false");
    this.devModeButton.title = "Dev Mode";
    this.devModeButton.append(createMonoIcon("dev-mode", 14));

    // Remote relay indicator: dim while connected, bright while payloads
    // travel up to the relay (blink at the transfer cadence), fully hidden
    // while disconnected. Click opens the web console in the system browser.
    this.remoteConsoleButton = document.createElement("button");
    this.remoteConsoleButton.type = "button";
    this.remoteConsoleButton.className = "title-bar-btn title-bar-remote";
    this.remoteConsoleButton.setAttribute("aria-label", "Open Remote Console");
    this.remoteConsoleButton.title = "Open Remote Console";
    this.remoteConsoleButton.append(createMonoIcon("remote-console", 14));

    // Notification bell (message center inbox) — sits beside the relay
    // indicator (signed-off order: relay, bell, Dev Mode, Detail, Setting).
    // Opaque solid badge per the chip/badge rule; hidden at zero unread.
    this.bellButton = document.createElement("button");
    this.bellButton.type = "button";
    this.bellButton.className = "title-bar-btn title-bar-bell";
    this.bellButton.setAttribute("aria-label", "Notifications");
    this.bellButton.title = "Notifications";
    this.bellButton.append(createMonoIcon("notifications", 14));
    this.bellBadge = document.createElement("span");
    this.bellBadge.className = "title-bar-bell-badge";
    this.bellBadge.hidden = true;
    this.bellButton.append(this.bellBadge);

    this.logsButton = document.createElement("button");
    this.logsButton.type = "button";
    this.logsButton.className = "title-bar-btn";
    this.logsButton.setAttribute("aria-label", "Detail");
    this.logsButton.setAttribute("aria-pressed", "false");
    this.logsButton.title = "Detail";
    this.logsButton.append(createMonoIcon("detail", 14));

    this.settingsButton = document.createElement("button");
    this.settingsButton.type = "button";
    this.settingsButton.className = "title-bar-btn";
    this.settingsButton.setAttribute("aria-label", "Setting");
    this.settingsButton.setAttribute("aria-pressed", "false");
    this.settingsButton.title = "Setting";
    this.settingsButton.append(createMonoIcon("settings", 14));

    // Remote console, then the notification bell beside it; Dev Mode right
    // beside Detail (the Dev panel toggle) — Setting stays rightmost
    // (before Windows caption group).
    this.actions.append(
      this.remoteConsoleButton,
      this.bellButton,
      this.devModeButton,
      this.logsButton,
      this.settingsButton,
    );
    this.root.append(drag, this.actions);
  }

  /**
   * Windows-only: append self-drawn caption buttons (min / max / close) after
   * the regular actions. Spec: docs/demo/windows-titlebar-controls.html.
   * macOS never calls this — it keeps native traffic lights.
   */
  addWindowControls(handlers: WindowControlsHandlers): void {
    if (this.captionGroup) return;
    this.actions.classList.add("has-caption");

    const group = document.createElement("div");
    group.className = "title-bar-caption-group";

    const mkButton = (className: string, label: string): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = className;
      btn.setAttribute("aria-label", label);
      btn.title = label;
      return btn;
    };

    const minimizeButton = mkButton("title-bar-caption-btn", "Minimize");
    minimizeButton.append(
      createLucideIcon(Minus, { size: 12, strokeWidth: 1.5 }),
    );

    this.maximizeButton = mkButton("title-bar-caption-btn", "Maximize");
    this.maximizeGlyphMax = createFunctionalIcon("WindowMaximize", 11);
    this.maximizeGlyphRestore = createLucideIcon(Copy, {
      size: 11,
      strokeWidth: 1.5,
    });
    this.maximizeButton.append(this.maximizeGlyphMax);

    const closeButton = mkButton(
      "title-bar-caption-btn caption-close",
      "Close",
    );
    closeButton.append(createLucideIcon(X, { size: 12, strokeWidth: 1.5 }));

    minimizeButton.addEventListener("click", handlers.onMinimize);
    this.maximizeButton.addEventListener("click", handlers.onToggleMaximize);
    closeButton.addEventListener("click", handlers.onClose);

    group.append(minimizeButton, this.maximizeButton, closeButton);
    this.captionGroup = group;
    this.actions.append(group);
  }

  /** Swap the Max glyph (Maximize ⇄ Restore); no-op without caption buttons. */
  setWindowMaximized(maximized: boolean): void {
    if (!this.maximizeButton || !this.maximizeGlyphMax || !this.maximizeGlyphRestore) {
      return;
    }
    const label = maximized ? "Restore" : "Maximize";
    this.maximizeButton.title = label;
    this.maximizeButton.setAttribute("aria-label", label);
    this.maximizeButton.replaceChildren(
      maximized ? this.maximizeGlyphRestore : this.maximizeGlyphMax,
    );
  }

  setLogsOpen(open: boolean): void {
    this.logsButton.classList.toggle("is-active", open);
    this.logsButton.setAttribute("aria-pressed", open ? "true" : "false");
  }

  setDevModeActive(active: boolean): void {
    this.devModeButton.classList.toggle("is-active", active);
    this.devModeButton.setAttribute("aria-pressed", active ? "true" : "false");
  }

  /** Activity pulse: light the badge (dense pulses = fast blink). */
  pulseRemoteActivity(): void {
    this.remoteConsoleButton.classList.add("is-visible", "is-transmitting");
  }

  /** Pulse decay — badge stays visible, blink light goes out. */
  settleRemoteActivity(): void {
    this.remoteConsoleButton.classList.remove("is-transmitting");
  }

  /**
   * Connection state drives visibility: dim while connected to the relay
   * (even with no traffic), fully hidden otherwise.
   */
  setRemoteConnected(connected: boolean): void {
    this.remoteConsoleButton.classList.toggle("is-visible", connected);
    if (!connected) this.remoteConsoleButton.classList.remove("is-transmitting");
  }

  setSettingsActive(active: boolean): void {
    this.settingsButton.classList.toggle("is-active", active);
    this.settingsButton.setAttribute("aria-pressed", active ? "true" : "false");
    // The gear toggles: while Settings is open it becomes the way back.
    const label = active ? "Back" : "Setting";
    this.settingsButton.title = label;
    this.settingsButton.setAttribute("aria-label", label);
  }

  /** Bell unread state; 0 hides the dot (no count text — tooltip carries it). */
  setBellUnread(count: number): void {
    const unread = count > 0;
    this.bellBadge.hidden = !unread;
    const label = unread ? `Notifications (${count} unread)` : "Notifications";
    this.bellButton.setAttribute("aria-label", label);
    this.bellButton.title = label;
  }


}
