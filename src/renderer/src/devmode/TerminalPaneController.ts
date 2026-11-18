import { isImeComposing } from "../ui/ime.js";
import type { TerminalPaneView } from "./TerminalPaneView.js";

const MAX_HISTORY = 100;

const MIRROR_SHELL_TOOL_NAMES = new Set(["run_shell", "exec_command"]);

const MIRROR_HEAD_CHARS = 1500;
const MIRROR_TAIL_CHARS = 2500;

const MIRROR_TERMINAL_STATUSES = new Set([
  "idle",
  "completed",
  "error",
  "cancelled",
]);

function truncateMirrorBody(text: string): string {
  if (text.length <= MIRROR_HEAD_CHARS + MIRROR_TAIL_CHARS) return text;
  const omitted = text.length - MIRROR_HEAD_CHARS - MIRROR_TAIL_CHARS;
  return `${text.slice(0, MIRROR_HEAD_CHARS)}\n…(truncated ${omitted} chars)…\n${text.slice(-MIRROR_TAIL_CHARS)}`;
}

export const MIRROR_PRESENT_TIMINGS = {
  typeMsPerChar: 22,
  typeCapChars: 80,
  holdMs: 200,
  flashMs: 300,
  flashCount: 3,
  instantHoldMs: 250,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export class TerminalPaneController {
  private unsubs: Array<() => void> = [];
  private activeRunId: string | null = null;
  private history: string[] = [];
  private historyIndex = -1;
  private draftBeforeHistory = "";
  private cwd = "";
  private mirrorSessionId: string | null = null;
  private pendingAgentRuns = new Map<string, true>();
  private mirrorQueue: Promise<void> = Promise.resolve();
  private agentPresenting = false;

  constructor(
    private readonly view: TerminalPaneView,
    private readonly deps?: { openPanel?: () => void },
  ) {
    this.bind();
    this.view.runButton.addEventListener("click", () => {
      void this.runCommand();
    });
    this.view.stopButton.addEventListener("click", () => {
      void this.stopCommand();
    });
  }

  requestStop(): void {
    void this.stopCommand();
  }

  destroy(): void {
    if (this.activeRunId) {
      void window.jellybot?.terminalCancel?.(this.activeRunId);
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  focus(): void {
    this.view.focusInput();
  }

  setWorkspace(path: string | null): void {
    if (path) {
      this.cwd = path;
      this.view.setCwd(path);
      return;
    }
    this.cwd = "";
    this.view.setCwd("(home)", "no active workspace");
  }

  setMirrorSession(sessionId: string | null): void {
    if (sessionId === this.mirrorSessionId) return;
    this.sealPendingAgentRuns();
    this.mirrorSessionId = sessionId;
  }

  private sealPendingAgentRuns(): void {
    if (this.pendingAgentRuns.size === 0) return;
    const ids = [...this.pendingAgentRuns.keys()];
    for (const id of ids) this.pendingAgentRuns.delete(id);
    this.mirrorQueue = this.mirrorQueue
      .then(() => {
        for (const _id of ids) {
          this.view.appendOutput("— (no result)\n", "meta");
          this.view.appendDivider();
        }
      })
      .catch(() => {});
  }

  private async presentAgentShellStart(command: string): Promise<void> {
    this.deps?.openPanel?.();
    const animate =
      !this.activeRunId && this.view.getCommand() === "";
    if (!animate) {
      this.view.appendOutput(`[agent] $ ${command}\n`, "agent");
      return;
    }
    const t = MIRROR_PRESENT_TIMINGS;
    const reduced = prefersReducedMotion();
    this.agentPresenting = true;
    try {
      this.view.input.classList.add("is-agent-filled");
      if (reduced || command.length > t.typeCapChars) {
        this.view.setCommand(command);
        await sleep(reduced ? t.instantHoldMs : t.holdMs);
      } else {
        this.view.setCommand("");
        for (const ch of command) {
          this.view.setCommand(this.view.getCommand() + ch);
          await sleep(t.typeMsPerChar);
        }
        await sleep(t.holdMs);
      }
      if (!reduced) {
        this.view.input.classList.add("flash-ring");
        await sleep(t.flashMs * t.flashCount);
        this.view.input.classList.remove("flash-ring");
      }
      if (this.view.getCommand() === command) this.view.clearCommand();
      this.view.input.classList.remove("is-agent-filled");
    } finally {
      this.agentPresenting = false;
    }
    this.view.appendOutput(`[agent] $ ${command}\n`, "agent");
  }

  private async appendAgentShellResult(
    sessionId: string,
    toolCallId: string,
  ): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.getSession) {
      throw new Error("getSession unavailable");
    }
    const session = await bridge.getSession(sessionId);
    if (!session) throw new Error("task unavailable");
    let body = "";
    for (const message of session.messages ?? []) {
      for (const part of message.parts ?? []) {
        if (part.type !== "tool_result" || part.toolCallId !== toolCallId) {
          continue;
        }
        const content = part.content as
          | Array<Record<string, unknown>>
          | undefined;
        const text = (Array.isArray(content) ? content : [])
          .filter((p) => p?.type === "text")
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("\n");
        if (text) body = text;
      }
    }
    if (!body) {
      this.view.appendOutput("— (no result)\n", "meta");
      this.view.appendDivider();
      return;
    }
    this.view.appendOutput(truncateMirrorBody(body), "stdout");
    this.view.appendDivider();
  }

  private bind(): void {
    const bridge = window.jellybot;
    if (bridge?.onTerminalOutput) {
      this.unsubs.push(
        bridge.onTerminalOutput((payload) => {
          if (payload.runId !== this.activeRunId) return;
          this.view.appendOutput(
            payload.text,
            payload.stream === "stderr" ? "stderr" : "stdout",
          );
        }),
      );
    }
    if (bridge?.onTerminalDone) {
      this.unsubs.push(
        bridge.onTerminalDone((payload) => {
          if (payload.runId !== this.activeRunId) return;
          if (typeof payload.cwd === "string" && payload.cwd.trim()) {
            this.cwd = payload.cwd.trim();
            this.view.setCwd(this.cwd);
          }
          this.view.appendDivider();
          this.activeRunId = null;
          this.view.setBusy(false);
          this.view.focusInput();
        }),
      );
    }
    if (bridge?.onAgentStream) {
      this.unsubs.push(
        bridge.onAgentStream((payload) => {
          if (payload.sessionId !== this.mirrorSessionId) return;
          const event = payload.event;
          if (!event || typeof event !== "object") return;
          if (event.type === "tool_call") {
            const id = typeof event.id === "string" ? event.id : null;
            if (!id) return;
            if (!MIRROR_SHELL_TOOL_NAMES.has(String(event.name ?? ""))) return;
            const args = event.arguments as Record<string, unknown> | undefined;
            const command =
              typeof args?.command === "string" ? args.command.trim() : "";
            if (!command) return;
            this.pendingAgentRuns.set(id, true);
            const cmd = command;
            this.mirrorQueue = this.mirrorQueue
              .then(() => this.presentAgentShellStart(cmd))
              .catch(() => {});
            return;
          }
          if (event.type === "tool_finished") {
            const id = typeof event.id === "string" ? event.id : null;
            if (!id || !this.pendingAgentRuns.has(id)) return;
            this.pendingAgentRuns.delete(id);
            const sessionId = payload.sessionId;
            this.mirrorQueue = this.mirrorQueue
              .then(() => this.appendAgentShellResult(sessionId, id))
              .catch(() => {
                this.view.appendOutput("— (no result)\n", "meta");
                this.view.appendDivider();
              });
            return;
          }
          if (event.type === "status") {
            const status = typeof event.status === "string" ? event.status : "";
            if (MIRROR_TERMINAL_STATUSES.has(status)) {
              this.sealPendingAgentRuns();
            }
            return;
          }
        }),
      );
    }

    this.view.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
        event.preventDefault();
        void this.runCommand();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.historyUp();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.historyDown();
        return;
      }
      if (event.key === "c" && (event.ctrlKey || event.metaKey) && this.activeRunId) {
        const sel = window.getSelection()?.toString() ?? "";
        if (!sel) {
          event.preventDefault();
          void this.stopCommand();
        }
      }
    });
  }

  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex < 0) {
      this.draftBeforeHistory = this.view.getCommand();
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    }
    this.view.setCommand(this.history[this.historyIndex] ?? "");
  }

  private historyDown(): void {
    if (this.historyIndex < 0) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.view.setCommand(this.history[this.historyIndex] ?? "");
      return;
    }
    this.historyIndex = -1;
    this.view.setCommand(this.draftBeforeHistory);
  }

  private pushHistory(command: string): void {
    if (!command) return;
    if (this.history[this.history.length - 1] === command) return;
    this.history.push(command);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    this.historyIndex = -1;
    this.draftBeforeHistory = "";
  }

  private async runCommand(): Promise<void> {
    if (this.agentPresenting) return;
    if (this.activeRunId) return;
    const command = this.view.getCommand().trim();
    if (!command) return;
    this.view.clearCommand();
    await this.executeCommand(command);
  }

  private async executeCommand(command: string): Promise<void> {
    const trimmed = command.trim();
    if (!trimmed) {
      this.focus();
      return;
    }
    if (this.activeRunId) {
      try {
        await window.jellybot?.terminalCancel?.(this.activeRunId);
      } catch {
      }
      this.activeRunId = null;
      this.view.setBusy(false);
    }

    const bridge = window.jellybot;
    if (!bridge?.terminalRun) {
      this.view.appendOutput(
        "Terminal IPC unavailable. Restart the app.\n",
        "stderr",
      );
      return;
    }

    this.pushHistory(trimmed);
    this.view.appendOutput(`$ ${trimmed}\n`, "meta");
    this.view.setBusy(true);

    try {
      const { runId } = await bridge.terminalRun({
        command: trimmed,
        cwd: this.cwd,
      });
      this.activeRunId = runId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.appendOutput(`${message}\n`, "stderr");
      this.activeRunId = null;
      this.view.setBusy(false);
    }
  }

  private async stopCommand(): Promise<void> {
    const runId = this.activeRunId;
    if (!runId) return;
    try {
      await window.jellybot?.terminalCancel?.(runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.appendOutput(`${message}\n`, "stderr");
    }
  }
}
