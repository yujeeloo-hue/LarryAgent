import { frameSourceFile } from "../../../debug/frameSource.js";
import { isCdpRecipe } from "../../../debug/debugCopy.js";
import { sameDebugWorkspace } from "../../../debug/debugWorkspace.js";
import { showTextPromptDialog } from "../ui/TextPromptDialogView.js";
import { showAlert } from "../ui/messageDialogs.js";
import {
  type BreakpointValue,
  type StoredBreakpoint,
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
  revealBuild?: (workspacePath: string) => void;
  revealFileLine: (
    path: string, line: number, isCurrent?: () => boolean,
  ) => Promise<void>;
  resolveSourcePath?: (path: string) => Promise<string>;
  isWorkspaceReady?: () => boolean;
  onSessionLive?: (live: boolean) => void;
  onSnapshot?: (snapshot: DebugSnapshot) => void;
  getDebugSourceRoots?: () => string[];
};

export type DebugHoverValue = {
  result: string;
  type?: string;
  variablesReference: number;
};

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

const SYMBOL_SPIN_GRACE_MS = 150;

export class DebugController {
  private readonly breakpoints = new Map<
    string,
    Map<number, BreakpointValue>
  >();
  private conditionPrompt: Promise<void> | null = null;
  private workspacePath: string | null | undefined;
  private workspaceGeneration = 0;
  private unwatch: (() => void) | null = null;
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
  private stopping = false;
  private destroyed = false;
  private sessionLive = false;
  private readonly keydown = (event: KeyboardEvent): void => {
    if (
      this.snapshot.status !== "stopped" ||
      isDevModalOpen() ||
      !this.canRevealWorkspace()
    ) {
      return;
    }
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
    window.addEventListener("keydown", this.keydown, true);
    const bridge = window.jellybot;
    if (!bridge?.onDebugState || !bridge.getDebugState) return;
    const initial = this.snapshot;
    this.unwatch = bridge.onDebugState((snapshot) => {
      void this.applySnapshot(snapshot);
    });
    void bridge.getDebugState()
      .then((snapshot) => {
        if (this.snapshot === initial) return this.applySnapshot(snapshot);
      })
      .catch(() => {});
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

  addBreakpoint(
    path: string,
    line: number,
    options: { condition?: string; enabled?: boolean } = {},
  ): void {
    const key = norm(path);
    const lines =
      this.breakpoints.get(key) ?? new Map<number, BreakpointValue>();
    const previous = lines.get(line);
    const condition = options.condition?.trim() ?? previous?.condition ?? "";
    const enabled = options.enabled ?? previous?.enabled ?? true;
    if (previous && previous.condition === condition && previous.enabled === enabled) {
      return;
    }
    lines.set(line, { condition, enabled });
    this.breakpoints.set(key, lines);
    this.commit(path);
  }

  setBreakpointCondition(path: string, line: number, condition: string): void {
    const next = condition.trim();
    const value = this.breakpoints.get(norm(path))?.get(line);
    if (!value) {
      this.addBreakpoint(path, line, { condition: next });
      return;
    }
    if (value.condition === next) return;
    value.condition = next;
    this.commit(path);
  }

  listBreakpoints(workspacePath?: string): StoredBreakpoint[] {
    const requested = workspacePath?.trim();
    const current = this.currentWorkspace() ?? "";
    if (requested && norm(requested) !== norm(current)) {
      return serializeBreakpoints(loadBreakpoints(requested));
    }
    return serializeBreakpoints(this.breakpoints);
  }

  reveal(): void {
    this.deps.revealPanel();
  }

  async start(buildId?: string): Promise<void> {
    const workspacePath = this.currentWorkspace();
    const bridge = window.jellybot;
    if (this.destroyed || !workspacePath || !bridge?.startDebug) return;
    const generation = this.workspaceGeneration;
    if (this.snapshot.status === "idle" || this.snapshot.status === "error") {
      void this.applySnapshot({ workspacePath, status: "starting", stack: [], locals: [] });
    }
    const pending = this.snapshot;
    const breakpoints = [...this.breakpoints]
      .filter(([bpPath]) => this.belongsToWorkspace(bpPath, workspacePath))
      .flatMap(([bpPath, lines]) =>
        this.linePayload(lines).map((bp) => ({ path: bpPath, ...bp })),
      );
    const result = await bridge.startDebug({ workspacePath, breakpoints, ...(buildId ? { buildId } : {}) });
    if (this.destroyed || result.ok || result.cancelled) return;
    if (result.snapshot) {
      if (this.snapshot === pending) void this.applySnapshot(result.snapshot);
      if (generation === this.workspaceGeneration) {
        this.deps.revealPanel();
        void showAlert(result.message, { title: "Debug" });
      }
      return;
    }
    // Keep the error in the panel so dismissing a native alert can't disrupt keyboard focus.
    await this.applySnapshot({
      workspacePath,
      status: "error",
      stack: [],
      locals: [],
      error: result.message,
    });
    if (generation !== this.workspaceGeneration || !this.canRevealWorkspace()) return;
    if (result.buildFailed) this.deps.revealBuild?.(workspacePath);
    else this.deps.revealPanel();
  }

  async stop(): Promise<void> {
    if (this.destroyed || this.stopping || this.snapshot.status === "idle") return;
    this.stopping = true;
    this.view.setStopPending(true);
    try {
      const res = await window.jellybot?.runDebugCommand?.("stop");
      if ((this.snapshot.status as DebugSnapshot["status"]) === "idle") {
        this.stopping = false;
        this.view.setStopPending(false);
      } else if (res && !res.ok && res.message) {
        this.stopping = false;
        this.view.setStopPending(false);
        void showAlert(`Stop failed — ${res.message}`, { title: "Debug" });
      }
    } catch {
      if ((this.snapshot.status as DebugSnapshot["status"]) !== "idle") {
        this.stopping = false;
        this.view.setStopPending(false);
      }
    }
  }

  async evaluateHover(expression: string): Promise<DebugHoverValue | null> {
    if (this.snapshot.status !== "stopped" || !this.canRevealWorkspace()) return null;
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
    if (this.destroyed) return;
    const next = path?.trim() ? path : null;
    if (this.workspacePath !== undefined && norm(this.workspacePath ?? "") === norm(next ?? "")) {
      this.paint();
      return;
    }
    this.workspacePath = next;
    this.workspaceGeneration += 1;
    this.revealedFrameKey = "";
    this.endSymbolSpin();
    this.deps.setEditorExecutionLocation(null);
    this.deps.setEditorFrameLocation(null);
    this.breakpoints.clear();
    for (const [file, lines] of loadBreakpoints(next)) {
      this.breakpoints.set(file, new Map(lines));
    }
    this.paint();
    void this.applySnapshot(this.snapshot);
  }

  destroy(): void {
    this.destroyed = true;
    this.endSymbolSpin();
    window.removeEventListener("keydown", this.keydown, true);
    this.unwatch?.();
    this.unwatch = null;
  }

  private async command(
    command: "pause" | "continue" | "next" | "stepIn" | "stepOut",
  ): Promise<void> {
    const result = await window.jellybot?.runDebugCommand?.(command);
    if (result && !result.ok && result.message) {
      void showAlert(`Debug command failed — ${result.message}`, { title: "Debug" });
    }
  }

  private async selectFrame(frame: DebugStackFrame): Promise<void> {
    if (this.snapshot.status !== "stopped") return;
    this.snapshot = { ...this.snapshot, selectedFrameId: frame.id };
    this.view.setSnapshot(this.snapshot);
    const isTop = frame.id === this.snapshot.stack[0]?.id;
    if (isTop || !frameSourceFile(frame) || frame.line <= 0) {
      this.deps.setEditorFrameLocation(null);
    }
    const path = frameSourceFile(frame);
    const generation = this.workspaceGeneration;
    const isCurrent = () =>
      generation === this.workspaceGeneration &&
      this.canRevealWorkspace() &&
      this.snapshot.status === "stopped" &&
      this.snapshot.selectedFrameId === frame.id;
    const needsSymbols =
      !isCdpRecipe(this.snapshot.recipe) && (!path || frame.line <= 0);
    const reveal =
      path && frame.line > 0 && isCurrent()
        ? this.resolveSourcePath(path).then((resolved) =>
            this.markFrameLocation(resolved, frame.line, isCurrent),
          )
        : Promise.resolve();
    if (needsSymbols) this.beginSymbolSpin(frame.id);
    try {
      const [, result] = await Promise.all([
        reveal,
        window.jellybot?.selectDebugFrame?.(frame.id),
      ]);
      if (result && !result.ok && result.message) {
        void showAlert(`Stack frame could not be opened — ${result.message}`, { title: "Debug" });
        return;
      }
      const hydrated = result?.frame;
      const hydratedPath = hydrated ? frameSourceFile(hydrated) : null;
      if (
        isCurrent() &&
        hydrated &&
        hydratedPath &&
        hydrated.line > 0 &&
        (hydratedPath !== path || hydrated.line !== frame.line)
      ) {
        const resolved = await this.resolveSourcePath(hydratedPath);
        await this.markFrameLocation(resolved, hydrated.line, isCurrent);
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

  private async markFrameLocation(
    path: string, line: number, isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    if (this.snapshot.selectedFrameId === this.snapshot.stack[0]?.id) {
      this.deps.setEditorExecutionLocation(path, line);
    } else {
      this.deps.setEditorFrameLocation(path, line);
    }
    await this.deps.revealFileLine(path, line, isCurrent);
  }

  private async selectTarget(targetId: string): Promise<void> {
    if (!isCdpRecipe(this.snapshot.recipe)) return;
    if (this.snapshot.selectedTargetId === targetId) return;
    const result = await window.jellybot?.selectDebugTarget?.(targetId);
    if (result && !result.ok && result.message) {
      void showAlert(`Debug target could not be opened — ${result.message}`, { title: "Debug" });
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
      void showAlert(`Thread could not be opened — ${result.message}`, { title: "Debug" });
    }
  }

  private async applySnapshot(snapshot: DebugSnapshot): Promise<void> {
    if (this.destroyed) return;
    this.snapshot = snapshot;
    this.deps.onSnapshot?.(snapshot);
    if (snapshot.status === "idle" && this.stopping) {
      this.stopping = false;
      this.view.setStopPending(false);
    }
    this.syncSessionLive();
    this.view.setSnapshot(snapshot);
    this.view.setForeignSession(this.foreignSessionLabel());
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
    await this.restoreWorkspaceState();
  }

  async restoreWorkspaceState(): Promise<void> {
    if (!this.canRevealWorkspace()) return;
    const { status, recipe, workspacePath, stack } = this.snapshot;
    if (status === "building" && recipe === "unreal") {
      this.deps.revealBuild?.(workspacePath);
    }
    if (status === "starting" && recipe) this.deps.revealPanel();
    if (status !== "stopped") return;

    this.deps.revealPanel();
    const frame = stack[0];
    const path = frame ? frameSourceFile(frame) : null;
    if (!frame || !path || frame.line <= 0) return;
    const generation = this.workspaceGeneration;
    const isCurrent = () => {
      const current = this.snapshot.stack[0];
      return (
        generation === this.workspaceGeneration &&
        this.canRevealWorkspace() &&
        this.snapshot.status === "stopped" &&
        current?.line === frame.line &&
        frameSourceFile(current) === path
      );
    };
    const resolved = await this.resolveSourcePath(path);
    if (!isCurrent()) return;
    this.deps.setEditorExecutionLocation(resolved, frame.line);
    const key = `${norm(resolved)}:${frame.line}`;
    if (key === this.revealedFrameKey) return;
    this.revealedFrameKey = key;
    await this.deps.revealFileLine(resolved, frame.line, isCurrent);
  }

  private currentWorkspace(): string | null {
    return this.workspacePath === undefined ? this.deps.getWorkspacePath() : this.workspacePath;
  }

  private canRevealWorkspace(): boolean {
    return (
      !this.destroyed &&
      !!this.currentWorkspace() &&
      !this.isForeignSession() &&
      (this.deps.isWorkspaceReady?.() ?? true)
    );
  }

  private isForeignSession(): boolean {
    const session = this.snapshot.workspacePath;
    const ws = this.currentWorkspace();
    return !!session && (!ws || !sameDebugWorkspace(ws, session));
  }

  private foreignSessionLabel(): string | null {
    if (this.snapshot.status === "idle" || !this.isForeignSession()) {
      return null;
    }
    const parts = norm(this.snapshot.workspacePath).split("/").filter(Boolean);
    return parts[parts.length - 1] ?? this.snapshot.workspacePath;
  }

  private syncSessionLive(): void {
    const live =
      this.snapshot.status !== "idle" && this.snapshot.workspacePath !== "";
    if (live === this.sessionLive) return;
    this.sessionLive = live;
    this.deps.onSessionLive?.(live);
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
      this.currentWorkspace(),
      this.breakpoints,
    );
  }

  private syncLive(path: string): void {
    if (
      this.snapshot.status === "idle" ||
      this.snapshot.status === "error" ||
      this.isForeignSession() ||
      !this.belongsToWorkspace(path, this.snapshot.workspacePath)
    ) {
      return;
    }
    const lines = this.breakpoints.get(norm(path)) ?? new Map();
    void window.jellybot
      ?.setDebugBreakpoints?.(path, this.linePayload(lines))
      .then((res) => {
        if (!res.ok && res.message) {
          void showAlert(`Breakpoint failed — ${res.message}`, { title: "Debug" });
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
    const roots = [root];
    if (norm(this.workspacePath ?? "").toLowerCase() === root) roots.push(...(this.deps.getDebugSourceRoots?.() ?? []).map(path => norm(path).replace(/\/+$/, "").toLowerCase()));
    return roots.some(sourceRoot => candidate === sourceRoot || candidate.startsWith(`${sourceRoot}/`));
  }
}
