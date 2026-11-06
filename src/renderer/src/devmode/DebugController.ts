import { frameSourceFile } from "../../../debug/frameSource.js";
import { isCdpRecipe } from "../../../debug/debugCopy.js";
import { showTextPromptDialog } from "../ui/TextPromptDialogView.js";
import {
  type BreakpointValue,
  loadBreakpoints,
  saveBreakpoints,
  serializeBreakpoints,
} from "./breakpointStore.js";
import { DebugPanelView, type DebugVariableNode } from "./DebugPanelView.js";
import { claimDevModal, isDevModalOpen } from "./modalLayer.js";

export type DebugControllerDeps = {
  getWorkspacePath: () => string | null;
  setEditorBreakpoints: (
    breakpoints: Map<string, Map<number, BreakpointValue>>,
  ) => void;
  setEditorExecutionLocation: (path: string | null, line?: number) => void;
  setEditorFrameLocation: (path: string | null, line?: number) => void;
  revealPanel: () => void;
  revealFileLine: (path: string, line: number) => Promise<void>;
  resolveSourcePath?: (path: string) => Promise<string>;
};

export type DebugHoverValue = {
  result: string;
  type?: string;
  variablesReference: number;
};

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Grace before the symbol spinner shows — cached modules answer faster. */
const SYMBOL_SPIN_GRACE_MS = 150;

/** Debug state/orchestration; the view remains presentation-only. */
export class DebugController {
  /** path → line → condition and enabled state. */
  private readonly breakpoints = new Map<
    string,
    Map<number, BreakpointValue>
  >();
  private conditionPrompt: Promise<void> | null = null;
  private workspacePath: string | null = null;
  private unwatch: (() => void) | null = null;
  /** Clicked frame whose module PDB main may be hydrating right now. */
  private symbolSpin: {
    frameId: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private snapshot: DebugSnapshot = {
    workspacePath: "",
    status: "idle",
    stack: [],
    locals: [],
  };
  private revealedFrameKey = "";
  /** True from Stop click until the session snapshot reports idle. */
  private stopping = false;
  /** F5 / F10 / F11 only act while the debuggee is actually paused. */
  private readonly keydown = (event: KeyboardEvent): void => {
    if (this.snapshot.status !== "stopped" || isDevModalOpen()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const command =
      event.key === "F5"
        ? "continue"
        : event.key === "F10"
          ? "next"
          : event.key === "F11"
            ? event.shiftKey
              ? "stepOut"
              : "stepIn"
            : null;
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    void this.command(command);
  };

  constructor(
    readonly view: DebugPanelView,
    private readonly deps: DebugControllerDeps,
  ) {
    view.continueButton.addEventListener("click", () => {
      void this.command("continue");
    });
    view.pauseButton.addEventListener("click", () => {
      void this.command("pause");
    });
    view.stepOverButton.addEventListener("click", () => {
      void this.command("next");
    });
    view.stepInButton.addEventListener("click", () => {
      void this.command("stepIn");
    });
    view.stepOutButton.addEventListener("click", () => {
      void this.command("stepOut");
    });
    view.stopButton.addEventListener("click", () => {
      void this.stop();
    });
    view.onFrameSelect = (frame) => {
      void this.selectFrame(frame);
    };
    view.onThreadSelect = (thread) => {
      void this.selectThread(thread.id);
    };
    view.onTargetSelect = (target) => {
      void this.selectTarget(target.id);
    };
    view.onBreakpointOpen = (row) => {
      void this.deps.revealFileLine(row.path, row.line);
    };
    view.onBreakpointRemove = (row) => {
      this.removeBreakpoint(row.path, row.line);
    };
    view.onBreakpointToggleEnabled = (row) => {
      this.setBreakpointEnabled(row.path, row.line, !row.enabled);
    };
    view.onBreakpointEditCondition = (row) => {
      void this.editBreakpointCondition(row.path, row.line);
    };
    view.onBreakpointClearAll = () => {
      this.clearAllBreakpoints();
    };
    view.onVariableExpand = (node) => this.expandPanelVariable(node);
  }

  mount(): void {
    // Capture phase so Monaco cannot swallow the step keys while it has focus.
    window.addEventListener("keydown", this.keydown, true);
    const bridge = window.jellybot;
    if (!bridge?.onDebugState || !bridge.getDebugState) return;
    this.unwatch = bridge.onDebugState((snapshot) => {
      void this.applySnapshot(snapshot);
    });
    void bridge.getDebugState().then((snapshot) => this.applySnapshot(snapshot));
  }

  toggleBreakpoint(path: string, line: number): void {
    const key = norm(path);
    const lines =
      this.breakpoints.get(key) ?? new Map<number, BreakpointValue>();
    if (lines.has(line)) lines.delete(line);
    else lines.set(line, { condition: "", enabled: true });
    if (lines.size === 0) this.breakpoints.delete(key);
    else this.breakpoints.set(key, lines);
    this.commit(path);
  }

  removeBreakpoint(path: string, line: number): void {
    const key = norm(path);
    const lines = this.breakpoints.get(key);
    if (!lines?.has(line)) return;
    lines.delete(line);
    if (lines.size === 0) this.breakpoints.delete(key);
    this.commit(path);
  }

  setBreakpointEnabled(path: string, line: number, enabled: boolean): void {
    const key = norm(path);
    const value = this.breakpoints.get(key)?.get(line);
    if (!value || value.enabled === enabled) return;
    value.enabled = enabled;
    this.commit(path);
  }

  clearAllBreakpoints(): void {
    if (this.breakpoints.size === 0) return;
    const paths = [...this.breakpoints.keys()];
    this.breakpoints.clear();
    this.commit();
    for (const path of paths) this.syncLive(path);
  }

  async editBreakpointCondition(path: string, line: number): Promise<void> {
    if (this.conditionPrompt) return;
    this.conditionPrompt = this.promptBreakpointCondition(path, line).finally(
      () => {
        this.conditionPrompt = null;
      },
    );
    await this.conditionPrompt;
  }

  async start(): Promise<void> {
    const workspacePath = this.workspacePath ?? this.deps.getWorkspacePath();
    const bridge = window.jellybot;
    if (!workspacePath || !bridge?.startDebug) return;
    this.deps.revealPanel();
    const starting: DebugSnapshot = {
      workspacePath,
      status: "starting",
      stack: [],
      locals: [],
    };
    await this.applySnapshot(starting);
    const breakpoints = [...this.breakpoints]
      .filter(([bpPath]) => this.belongsToWorkspace(bpPath, workspacePath))
      .flatMap(([bpPath, lines]) =>
        this.linePayload(lines).map((bp) => ({ path: bpPath, ...bp })),
      );
    const result = await bridge.startDebug({ workspacePath, breakpoints });
    if (!result.ok && !result.cancelled) {
      await this.applySnapshot({
        workspacePath,
        status: "error",
        stack: [],
        locals: [],
        error: result.message,
      });
      window.alert(`Debug could not start — ${result.message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping || this.snapshot.status === "idle") return;
    this.stopping = true;
    this.view.setStopPending(true);
    try {
      const res = await window.jellybot?.runDebugCommand?.("stop");
      // The await above can flip snapshot.status (IPC push); re-read through
      // a widened local so the type system doesn't keep the stale narrowing
      // from the early-return guard (TS narrows properties across awaits).
      if ((this.snapshot.status as DebugSnapshot["status"]) === "idle") {
        this.stopping = false;
        this.view.setStopPending(false);
      } else if (res && !res.ok && res.message) {
        this.stopping = false;
        this.view.setStopPending(false);
        window.alert(`Stop failed — ${res.message}`);
      }
    } catch {
      if ((this.snapshot.status as DebugSnapshot["status"]) !== "idle") {
        this.stopping = false;
        this.view.setStopPending(false);
      }
    }
  }

  async evaluateHover(expression: string): Promise<DebugHoverValue | null> {
    if (this.snapshot.status !== "stopped") return null;
    // Evaluate in the frame the user opened, not always the top of the stack.
    const frame =
      this.snapshot.stack.find(
        (entry) => entry.id === this.snapshot.selectedFrameId,
      ) ?? this.snapshot.stack[0];
    if (!frame) return null;

    const local = this.snapshot.locals.find(
      (variable) => variable.name === expression,
    );
    if (local) {
      return {
        result: local.value,
        ...(local.type ? { type: local.type } : {}),
        variablesReference: local.variablesReference,
      };
    }

    const response = await window.jellybot?.evaluateDebugExpression?.(
      expression,
      frame.id,
    );
    if (!response?.ok) return null;
    return {
      result: response.result,
      ...(response.type ? { type: response.type } : {}),
      variablesReference: response.variablesReference,
    };
  }

  async expandHoverVariable(
    variablesReference: number,
  ): Promise<DebugVariable[]> {
    if (this.snapshot.status !== "stopped" || variablesReference <= 0) return [];
    const response =
      await window.jellybot?.getDebugVariables?.(variablesReference);
    return response?.ok ? response.variables : [];
  }

  /**
   * Variables-column expansion: same lazy DAP fetch as the hover tree, with
   * the ancestor path carried per node so reference cycles stop instead of
   * recursing forever (a global "seen" set would wrongly mark two aliases
   * of one object as a cycle).
   */
  private async expandPanelVariable(
    node: DebugVariableNode,
  ): Promise<DebugVariableNode[]> {
    const reference = node.variablesReference;
    if (this.snapshot.status !== "stopped" || reference <= 0) return [];
    try {
      const variables = await this.expandHoverVariable(reference);
      const ancestors = new Set(node.ancestors);
      ancestors.add(reference);
      return variables.map((variable) =>
        this.toPanelNode(variable, node.depth + 1, ancestors),
      );
    } catch {
      // Adapter hiccup — an empty subtree reads better than a thrown
      // promise inside a click handler.
      return [];
    }
  }

  private toPanelNode(
    variable: DebugVariable,
    depth: number,
    ancestors: ReadonlySet<number>,
  ): DebugVariableNode {
    const reference = variable.variablesReference;
    const cycle = reference > 0 && ancestors.has(reference);
    return {
      name: variable.name,
      value: variable.value,
      ...(variable.type ? { type: variable.type } : {}),
      variablesReference: reference,
      depth,
      ancestors,
      expandable: reference > 0 && !cycle,
    };
  }

  async setWorkspace(path: string | null): Promise<void> {
    const next = path?.trim() ? path : null;
    if (norm(this.workspacePath ?? "") === norm(next ?? "")) {
      this.paint();
      return;
    }
    this.persist();
    const previous = this.workspacePath;
    this.workspacePath = next;
    this.breakpoints.clear();
    for (const [file, lines] of loadBreakpoints(next)) {
      this.breakpoints.set(file, new Map(lines));
    }
    this.paint();
    if (
      previous &&
      this.snapshot.workspacePath &&
      norm(previous) === norm(this.snapshot.workspacePath) &&
      this.snapshot.status !== "idle"
    ) {
      await this.stop();
    }
  }

  destroy(): void {
    this.persist();
    this.endSymbolSpin();
    window.removeEventListener("keydown", this.keydown, true);
    this.unwatch?.();
    this.unwatch = null;
    void this.stop();
  }

  private async command(
    command: "pause" | "continue" | "next" | "stepIn" | "stepOut",
  ): Promise<void> {
    const result = await window.jellybot?.runDebugCommand?.(command);
    if (result && !result.ok && result.message) {
      window.alert(`Debug command failed — ${result.message}`);
    }
  }

  /**
   * Call-stack click: highlight the frame right away, load its locals, and
   * open its source with a green arrow + line wash (the gold execution
   * marker stays on the top frame). Frames above the top one usually carry
   * build-machine paths, so the reveal goes through the workspace path
   * resolver first.
   */
  private async selectFrame(frame: DebugStackFrame): Promise<void> {
    if (this.snapshot.status !== "stopped") return;
    // Paint the selection before DAP answers so the click never feels dead.
    this.snapshot = { ...this.snapshot, selectedFrameId: frame.id };
    this.view.setSnapshot(this.snapshot);
    // The top frame owns the gold execution marker already; picking it back
    // just retires the green frame marker.
    const isTop = frame.id === this.snapshot.stack[0]?.id;
    if (isTop || !frameSourceFile(frame) || frame.line <= 0) {
      this.deps.setEditorFrameLocation(null);
    }
    // An Engine frame answers with a disassembly source naming the `.dll`;
    // only a real file is worth revealing before symbols arrive.
    const path = frameSourceFile(frame);
    // Main hydrates a missing module PDB inside the selectDebugFrame call —
    // minutes over a symbol server, a few round-trips when already cached.
    // The row spins for the long case; the grace hides the short one.
    const needsSymbols =
      !isCdpRecipe(this.snapshot.recipe) && (!path || frame.line <= 0);
    const reveal =
      path && frame.line > 0
        ? this.resolveSourcePath(path).then((resolved) =>
            this.markFrameLocation(resolved, frame.line),
          )
        : Promise.resolve();
    if (needsSymbols) this.beginSymbolSpin(frame.id);
    try {
      const [, result] = await Promise.all([
        reveal,
        window.jellybot?.selectDebugFrame?.(frame.id),
      ]);
      if (result && !result.ok && result.message) {
        window.alert(`Stack frame could not be opened — ${result.message}`);
        return;
      }
      // A source-less Engine frame may have caused main to load exactly that
      // module's PDB. Use the refreshed frame returned after stackTrace
      // rather than waiting for another stop event.
      const hydrated = result?.frame;
      const hydratedPath = hydrated ? frameSourceFile(hydrated) : null;
      if (
        hydrated &&
        hydratedPath &&
        hydrated.line > 0 &&
        (hydratedPath !== path || hydrated.line !== frame.line)
      ) {
        const resolved = await this.resolveSourcePath(hydratedPath);
        await this.markFrameLocation(resolved, hydrated.line);
      }
    } finally {
      if (needsSymbols) this.endSymbolSpin();
    }
  }

  private beginSymbolSpin(frameId: number): void {
    this.endSymbolSpin();
    this.symbolSpin = {
      frameId,
      timer: setTimeout(() => {
        this.view.setFrameSymbolLoading(frameId, true);
      }, SYMBOL_SPIN_GRACE_MS),
    };
  }

  private endSymbolSpin(): void {
    const spin = this.symbolSpin;
    if (!spin) return;
    clearTimeout(spin.timer);
    this.symbolSpin = null;
    this.view.setFrameSymbolLoading(spin.frameId, false);
  }

  /**
   * Reveal a frame's line. Callers (non-top frames) pin the green frame
   * marker; the top frame owns the gold execution marker, which a hydrated
   * Engine source may have just moved off the module disassembly.
   */
  private async markFrameLocation(path: string, line: number): Promise<void> {
    if (this.snapshot.selectedFrameId === this.snapshot.stack[0]?.id) {
      this.deps.setEditorExecutionLocation(path, line);
    } else {
      this.deps.setEditorFrameLocation(path, line);
    }
    await this.deps.revealFileLine(path, line);
  }

  private async selectTarget(targetId: string): Promise<void> {
    if (!isCdpRecipe(this.snapshot.recipe)) return;
    if (this.snapshot.selectedTargetId === targetId) return;
    const result = await window.jellybot?.selectDebugTarget?.(targetId);
    if (result && !result.ok && result.message) {
      window.alert(`Session could not be opened — ${result.message}`);
    }
  }

  private async selectThread(threadId: number): Promise<void> {
    if (
      this.snapshot.status !== "stopped" ||
      this.snapshot.selectedThreadId === threadId
    ) {
      return;
    }
    const result = await window.jellybot?.selectDebugThread?.(threadId);
    if (result && !result.ok && result.message) {
      window.alert(`Thread could not be opened — ${result.message}`);
    }
  }

  private async applySnapshot(snapshot: DebugSnapshot): Promise<void> {
    this.snapshot = snapshot;
    if (snapshot.status === "idle") this.stopping = false;
    this.view.setSnapshot(snapshot);
    // Every adapter stop event resets the selection to the top frame, so a
    // stale green caller marker must not outlive its stack. Session end /
    // resume clears it too.
    if (
      snapshot.status !== "stopped" ||
      (snapshot.selectedFrameId ?? snapshot.stack[0]?.id) ===
        snapshot.stack[0]?.id
    ) {
      this.deps.setEditorFrameLocation(null);
    }
    const executionFrame = snapshot.status === "stopped" ? snapshot.stack[0] : null;
    const executionPath = executionFrame
      ? frameSourceFile(executionFrame)
      : null;
    if (!executionPath || !executionFrame || executionFrame.line <= 0) {
      this.deps.setEditorExecutionLocation(null);
      if (snapshot.status !== "stopped") this.revealedFrameKey = "";
    }
    // The Build tab owns the screen while compiling (its log auto-switches
    // there); take it back once the adapter is launching.
    if (snapshot.status === "starting") this.deps.revealPanel();
    if (snapshot.status === "stopped") {
      this.deps.revealPanel();
      const frame = snapshot.stack[0];
      const path = frame ? frameSourceFile(frame) : null;
      if (!path || !frame || frame.line <= 0) return;
      const resolved = await this.resolveSourcePath(path);
      const current = this.snapshot.stack[0];
      if (
        this.snapshot.status !== "stopped" ||
        (current ? frameSourceFile(current) : null) !== path ||
        current?.line !== frame.line
      ) {
        return;
      }
      this.deps.setEditorExecutionLocation(resolved, frame.line);
      const key = `${resolved.replace(/\\/g, "/").toLowerCase()}:${frame.line}`;
      if (key === this.revealedFrameKey) return;
      this.revealedFrameKey = key;
      await this.deps.revealFileLine(resolved, frame.line);
    }
  }

  private async resolveSourcePath(path: string): Promise<string> {
    try {
      return (await this.deps.resolveSourcePath?.(path)) ?? path;
    } catch {
      return path;
    }
  }

  private async promptBreakpointCondition(
    path: string,
    line: number,
  ): Promise<void> {
    const key = norm(path);
    const current =
      this.breakpoints.get(key)?.get(line)?.condition ?? "";
    const release = claimDevModal();
    try {
      const value = await showTextPromptDialog({
        title: "Breakpoint condition",
        message:
          "Break when this expression is true. Leave empty for an unconditional breakpoint.",
        defaultValue: current,
        confirmLabel: "Set",
        cancelLabel: "Cancel",
        allowEmpty: true,
      });
      if (value === null) return;
      const lines =
        this.breakpoints.get(key) ?? new Map<number, BreakpointValue>();
      const previous = lines.get(line);
      lines.set(line, {
        condition: value.trim(),
        enabled: previous?.enabled ?? true,
      });
      this.breakpoints.set(key, lines);
      this.commit(path);
    } finally {
      release();
    }
  }

  private commit(syncPath?: string): void {
    this.paint();
    if (syncPath) this.syncLive(syncPath);
  }

  private paint(): void {
    this.deps.setEditorBreakpoints(this.breakpoints);
    this.view.setBreakpoints(serializeBreakpoints(this.breakpoints));
    this.persist();
  }

  private persist(): void {
    saveBreakpoints(
      this.workspacePath ?? this.deps.getWorkspacePath(),
      this.breakpoints,
    );
  }

  private syncLive(path: string): void {
    if (
      this.snapshot.status === "idle" ||
      this.snapshot.status === "error" ||
      !this.belongsToWorkspace(path, this.snapshot.workspacePath)
    ) {
      return;
    }
    const lines = this.breakpoints.get(norm(path)) ?? new Map();
    void window.jellybot
      ?.setDebugBreakpoints?.(path, this.linePayload(lines))
      .then((res) => {
        if (!res.ok && res.message) {
          window.alert(`Breakpoint failed — ${res.message}`);
        }
      });
  }

  private linePayload(
    lines: Map<number, BreakpointValue>,
  ): Array<{ line: number; condition?: string }> {
    return [...lines.entries()]
      .filter(([, value]) => value.enabled)
      .sort((a, b) => a[0] - b[0])
      .map(([line, value]) =>
        value.condition
          ? { line, condition: value.condition }
          : { line },
      );
  }

  private belongsToWorkspace(path: string, workspacePath: string): boolean {
    const root = norm(workspacePath).replace(/\/+$/, "").toLowerCase();
    const candidate = norm(path).toLowerCase();
    return candidate === root || candidate.startsWith(`${root}/`);
  }
}
