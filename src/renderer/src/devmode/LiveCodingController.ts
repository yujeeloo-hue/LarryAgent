import { sameDebugWorkspace } from "../../../debug/debugWorkspace.js";
import { supportsUnrealLiveCoding, type LiveCodingChoice } from "../../../unreal/liveCoding.js";
import { showAlert } from "../ui/messageDialogs.js";
import { getDevModeLiveCodingEnabled, subscribeDevModePreferences } from "../state/devModePreferences.js";
import type { DebugPanelView } from "./DebugPanelView.js";

const POLL_MS = 2500;

export class LiveCodingController {
  private root: string | null = null;
  private choice: LiveCodingChoice | null = null;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private queued = false;
  private launchPending = false;
  private visible = false;
  private disposed = false;
  private offTask: (() => void) | null = null;
  private offPreferences: (() => void) | null = null;
  private preferencesEnabled: boolean | null = null;

  constructor(
    private readonly view: DebugPanelView,
    private readonly deps: { revealBuild: (workspacePath: string) => void },
  ) {
    view.onLiveCoding = () => { void this.compile(); };
  }

  start(): void {
    this.offTask = window.jellybot?.onDevTaskExit?.(event => {
      if (!this.root || !sameDebugWorkspace(event.workspacePath, this.root)) return;
      if (event.task === "build" || event.task === "run") this.refresh();
    }) ?? null;
    this.preferencesEnabled = getDevModeLiveCodingEnabled();
    this.offPreferences = subscribeDevModePreferences(() => this.syncPreferences());
  }

  setWorkspace(root: string | null): void {
    this.setChoice(root, null);
  }

  setChoice(root: string | null, choice: LiveCodingChoice | null): void {
    const sameChoice = root === this.root && (choice?.id ?? null) === (this.choice?.id ?? null);
    this.epoch += 1;
    this.root = root;
    this.choice = choice;
    if (!sameChoice) {
      this.launchPending = false;
      this.visible = false;
    }
    this.syncAvailability();
  }

  refresh(): void {
    if (this.pending) {
      this.queued = true;
      return;
    }
    const epoch = this.epoch;
    this.pending = this.poll(epoch).finally(() => {
      this.pending = null;
      if (this.queued && !this.disposed) {
        this.queued = false;
        this.refresh();
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.stopPoll();
    this.offTask?.();
    this.offTask = null;
    this.offPreferences?.();
    this.offPreferences = null;
    this.view.onLiveCoding = null;
  }

  private syncPreferences(): void {
    const enabled = getDevModeLiveCodingEnabled();
    if (enabled === this.preferencesEnabled) return;
    this.preferencesEnabled = enabled;
    this.syncAvailability();
  }

  private available(): boolean {
    return this.preferencesEnabled === true
      && !!this.root && !!this.choice && supportsUnrealLiveCoding(this.choice);
  }

  private syncAvailability(): void {
    if (!this.available()) {
      this.stopPoll();
      this.visible = false;
      this.view.setLiveCodingVisible(false);
      this.view.setLiveCodingBusy(false);
      return;
    }
    this.arm();
    this.refresh();
  }

  private stopPoll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || !this.available()) return;
      this.refresh();
      this.arm();
    }, POLL_MS);
  }

  private async poll(epoch: number): Promise<void> {
    const root = this.root;
    const choice = this.choice;
    const bridge = window.jellybot;
    if (!this.available() || !root || !choice || !bridge?.unrealEditorRunning || !bridge.getDevTaskState) {
      if (epoch !== this.epoch) return;
      this.visible = false;
      this.view.setLiveCodingVisible(false);
      this.view.setLiveCodingBusy(false);
      return;
    }
    try {
      const [running, state] = await Promise.all([
        bridge.unrealEditorRunning(root, choice.id),
        bridge.getDevTaskState(root),
      ]);
      if (epoch !== this.epoch || this.disposed) return;
      const compiling = state.active.some(run => run.task === "build");
      const editorUp = running.ok && running.running;
      const visible = this.available() && (editorUp || ((compiling || this.launchPending) && this.visible));
      this.visible = visible;
      this.view.setLiveCodingVisible(visible);
      this.view.setLiveCodingBusy(visible && (compiling || this.launchPending));
    } catch {
      if (epoch !== this.epoch || this.disposed) return;
    }
  }

  private async compile(): Promise<void> {
    const root = this.root;
    const choice = this.choice;
    const bridge = window.jellybot;
    if (this.launchPending || this.view.liveCodingButton.hidden || this.view.liveCodingButton.disabled) return;
    if (!this.available() || !root || !choice || !bridge?.buildUnreal) return;
    this.launchPending = true;
    this.view.setLiveCodingBusy(true);
    this.deps.revealBuild(root);
    try {
      const result = await bridge.buildUnreal(root, choice.id, "liveCoding");
      if (!result.ok) void showAlert(result.message, { title: "Live Coding" });
    } catch (error) {
      void showAlert(String(error), { title: "Live Coding" });
    } finally {
      this.launchPending = false;
      this.refresh();
    }
  }
}
