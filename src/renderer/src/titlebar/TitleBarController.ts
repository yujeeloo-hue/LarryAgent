import type { TitleBarView } from "./TitleBarView.js";

export class TitleBarController {
  private logsToggleHandler: ((open: boolean) => void) | undefined;
  private settingsClickHandler: (() => void) | undefined;
  private remoteConsoleHandler: (() => void) | undefined;
  private devModeToggleHandler: (() => void) | undefined;
  private logsOpen = false;
  private settingsActive = false;
  private devModeActive = false;

  constructor(private readonly view: TitleBarView) {}

  mount(): HTMLElement {
    this.view.logsButton.addEventListener("click", () => {
      this.setLogsOpen(!this.logsOpen);
      this.logsToggleHandler?.(this.logsOpen);
    });
    this.view.settingsButton.addEventListener("click", () => {
      this.settingsClickHandler?.();
    });
    this.view.remoteConsoleButton.addEventListener("click", () => {
      this.remoteConsoleHandler?.();
    });
    this.view.devModeButton.addEventListener("click", () => {
      this.setDevModeActive(!this.devModeActive);
      this.devModeToggleHandler?.();
    });
    return this.view.root;
  }

  attachWindowControls(input: {
    platform: string;
    controls: {
      minimize: () => Promise<unknown>;
      toggleMaximize: () => Promise<unknown>;
      close: () => Promise<unknown>;
    };
    onMaximizeChanged: (
      handler: (payload: { maximized: boolean }) => void,
    ) => () => void;
  }): void {
    if (input.platform !== "win32") return;
    this.view.addWindowControls({
      onMinimize: () => void input.controls.minimize(),
      onToggleMaximize: () => void input.controls.toggleMaximize(),
      onClose: () => void input.controls.close(),
    });
    input.onMaximizeChanged((payload) => {
      this.view.setWindowMaximized(payload.maximized);
    });
  }

  onLogsToggle(handler: (open: boolean) => void): void {
    this.logsToggleHandler = handler;
  }

  onSettingsClick(handler: () => void): void {
    this.settingsClickHandler = handler;
  }

  onRemoteConsoleOpen(handler: () => void): void {
    this.remoteConsoleHandler = handler;
  }

  onDevModeToggle(handler: () => void): void {
    this.devModeToggleHandler = handler;
  }

  get bellButton(): HTMLButtonElement {
    return this.view.bellButton;
  }

  setBellUnread(count: number): void {
    this.view.setBellUnread(count);
  }

  attachRemoteSignal(bridge: {
    getRemoteStatus: () => Promise<{ status: string }>;
    onRemoteStatus: (
      listener: (payload: { status: string; detail?: string }) => void,
    ) => () => void;
    onRemoteActivity: (listener: () => void) => () => void;
  }): void {
    const apply = (status: string) => this.view.setRemoteConnected(status === "connected");
    void bridge
      .getRemoteStatus()
      .then(({ status }) => apply(status))
      .catch(() => {});
    bridge.onRemoteStatus(({ status }) => apply(status));
    let settleTimer: number | undefined;
    bridge.onRemoteActivity(() => {
      this.view.pulseRemoteActivity();
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => this.view.settleRemoteActivity(), 240);
    });
  }

  setLogsOpen(open: boolean): void {
    this.logsOpen = open;
    this.view.setLogsOpen(open);
  }

  setSettingsActive(active: boolean): void {
    this.settingsActive = active;
    this.view.setSettingsActive(active);
  }

  setDevModeActive(active: boolean): void {
    this.devModeActive = active;
    this.view.setDevModeActive(active);
  }



  isLogsOpen(): boolean {
    return this.logsOpen;
  }

  isSettingsActive(): boolean {
    return this.settingsActive;
  }
}
