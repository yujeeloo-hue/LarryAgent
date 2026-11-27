import {
  BrushCleaning,
  Play,
  Square,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { paneHeadIcon } from "./paneHeadIcons.js";
import { ChunkLog, type ChunkKind, type LiveLine } from "./chunkLog.js";

export class TerminalPaneView {
  readonly root: HTMLElement;
  readonly outputEl: HTMLElement;
  readonly log: ChunkLog;
  readonly cwdEl: HTMLElement;
  readonly input: HTMLInputElement;
  readonly runButton: HTMLButtonElement;
  readonly stopButton: HTMLButtonElement;
  readonly clearButton: HTMLButtonElement;
  busy = false;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "terminal-pane";

    this.outputEl = document.createElement("pre");
    this.outputEl.className = "terminal-pane-output";
    this.outputEl.setAttribute("aria-label", "Terminal output");
    this.outputEl.setAttribute("role", "log");
    this.outputEl.setAttribute("aria-live", "polite");
    this.log = new ChunkLog(this.outputEl);

    this.cwdEl = document.createElement("code");
    this.cwdEl.className = "terminal-pane-cwd";
    this.cwdEl.textContent = "—";

    const form = document.createElement("div");
    form.className = "terminal-pane-form";

    const prompt = document.createElement("span");
    prompt.className = "terminal-pane-prompt";
    prompt.textContent = "$";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "terminal-pane-input";
    this.input.placeholder = "Run a command…";
    this.input.setAttribute("aria-label", "Shell command");
    this.input.autocomplete = "off";
    this.input.spellcheck = false;

    this.runButton = document.createElement("button");
    this.runButton.type = "button";
    this.runButton.className = "terminal-pane-btn";
    this.runButton.title = "Run";
    this.runButton.setAttribute("aria-label", "Run");
    this.runButton.append(createLucideIcon(Play, { size: 14 }));

    this.stopButton = document.createElement("button");
    this.stopButton.type = "button";
    this.stopButton.className = "terminal-pane-btn is-stop";
    this.stopButton.title = "Stop";
    this.stopButton.setAttribute("aria-label", "Stop");
    this.stopButton.disabled = true;
    this.stopButton.append(createLucideIcon(Square, { size: 12 }));

    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "terminal-pane-btn is-clear";
    this.clearButton.title = "Clear output";
    this.clearButton.setAttribute("aria-label", "Clear output");
    this.clearButton.append(paneHeadIcon(BrushCleaning));
    this.clearButton.addEventListener("click", () => this.clearOutput());

    form.append(
      this.cwdEl,
      prompt,
      this.input,
      this.runButton,
      this.stopButton,
      this.clearButton,
    );
    this.root.append(this.outputEl, form);
  }

  setCwd(path: string, fallbackNote?: string): void {
    this.cwdEl.textContent = path;
    this.cwdEl.title = fallbackNote ? `${path} (${fallbackNote})` : path;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.runButton.disabled = busy;
    this.stopButton.disabled = !busy;
    this.input.disabled = busy;
  }

  appendOutput(text: string, kind: ChunkKind = "stdout"): void {
    this.log.appendOutput(text, kind);
  }

  appendEndLine(text: string, ok: boolean): void {
    this.log.appendEndLine(text, ok);
  }

  appendDivider(): void {
    this.log.appendDivider();
  }

  openLine(kind: ChunkKind): LiveLine {
    return this.log.openLine(kind);
  }

  clearOutput(): void {
    this.log.clear();
  }

  getCommand(): string {
    return this.input.value;
  }

  setCommand(value: string): void {
    this.input.value = value;
  }

  clearCommand(): void {
    this.input.value = "";
  }

  focusInput(): void {
    this.input.focus();
  }
}
