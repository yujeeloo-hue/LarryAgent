import {
  BrushCleaning,
  Play,
  Square,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { paneHeadIcon } from "./paneHeadIcons.js";

const MAX_CHUNKS = 3000;
const TRIM_BATCH = 500;

export class TerminalPaneView {
  readonly root: HTMLElement;
  readonly outputEl: HTMLElement;
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

  appendOutput(
    text: string,
    kind: "stdout" | "stderr" | "meta" | "agent" = "stdout",
  ): void {
    const span = document.createElement("span");
    span.className = `terminal-pane-chunk is-${kind}`;
    span.textContent = text;
    this.outputEl.append(span);
    this.trimOutput();
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  appendDivider(): void {
    const rule = document.createElement("span");
    rule.className = "terminal-pane-divider";
    rule.setAttribute("role", "separator");
    rule.setAttribute("aria-hidden", "true");
    this.outputEl.append(rule);
    this.trimOutput();
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private trimOutput(): void {
    const count = this.outputEl.childElementCount;
    if (count <= MAX_CHUNKS) return;
    const drop = Math.min(TRIM_BATCH, count - MAX_CHUNKS);
    for (let i = 0; i < drop && this.outputEl.firstElementChild; i++) {
      this.outputEl.firstElementChild.remove();
    }
  }

  clearOutput(): void {
    this.outputEl.replaceChildren();
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
