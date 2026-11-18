import type { JsonObject } from "../session/types.js";

export type DebugToolStatus =
  | "idle"
  | "building"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export type DebugToolCommand =
  | "pause"
  | "continue"
  | "next"
  | "stepIn"
  | "stepOut";

export type DebugToolFrame = {
  id: number;
  name: string;
  line: number;
  column: number;
  file?: string;
};

export type DebugToolThread = { id: number; name: string };

export type DebugToolVariable = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
};

export type DebugToolTarget = {
  id: string;
  kind: "lldb" | "node" | "chrome";
  label: string;
  status: "starting" | "running" | "stopped" | "ended";
  stoppedReason?: string;
};

export type DebugToolConsoleRow = {
  timestamp: number;
  direction: "send" | "receive" | "error";
  text: string;
};

export type DebugToolStopped = {
  reason?: string;
  description?: string;
  text?: string;
  threadId?: number;
};

export type DebugToolSnapshot = {
  workspacePath: string;
  status: DebugToolStatus;
  recipe?: string;
  adapterPath?: string;
  adapterVersion?: string;
  program?: string;
  progressText?: string;
  error?: string;
  stopped?: DebugToolStopped;
  threads: DebugToolThread[];
  selectedThreadId?: number;
  selectedFrameId?: number;
  stack: DebugToolFrame[];
  locals: DebugToolVariable[];
  targets: DebugToolTarget[];
  selectedTargetId?: string;
  console: DebugToolConsoleRow[];
};

export type DebugToolBreakpoint = {
  path: string;
  line: number;
  condition: string;
  enabled: boolean;
};

export type DebugToolBreakpointOp =
  | { action: "list" }
  | {
      action: "add";
      path: string;
      line: number;
      condition?: string;
      enabled?: boolean;
    }
  | { action: "remove"; path: string; line: number }
  | { action: "enable"; path: string; line: number }
  | { action: "disable"; path: string; line: number }
  | { action: "set_condition"; path: string; line: number; condition: string }
  | { action: "clear" };

export type DebugToolBreakpointsResult =
  | { ok: true; breakpoints: DebugToolBreakpoint[] }
  | { ok: false; message: string };

export type DebugToolStartResult =
  | {
      ok: true;
      snapshot: DebugToolSnapshot;
      pending: boolean;
    }
  | { ok: false; message: string; cancelled?: boolean; snapshot?: DebugToolSnapshot };

export type DebugToolEvaluateResult =
  | { ok: true; result: string; type?: string; variablesReference: number }
  | { ok: false; message: string };

export type DebugToolVariablesResult =
  | { ok: true; variables: DebugToolVariable[] }
  | { ok: false; message: string };

export type DebugControlPort = {
  ensureDevMode(): Promise<{ ok: true } | { ok: false; message: string }>;
  start(input: {
    workspacePath: string;
    buildId?: string;
    autoBuild?: boolean;
    waitMs: number;
  }): Promise<DebugToolStartResult>;
  stop(): Promise<{ ok: boolean; message?: string }>;
  command(command: DebugToolCommand): Promise<{ ok: boolean; message?: string }>;
  state(): DebugToolSnapshot;
  waitForStatus(input: {
    statuses: DebugToolStatus[];
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<DebugToolSnapshot>;
  selectFrame(frameId: number): Promise<{ ok: boolean; message?: string }>;
  selectThread(threadId: number): Promise<{ ok: boolean; message?: string }>;
  selectTarget(targetId: string): Promise<{ ok: boolean; message?: string }>;
  evaluate(expression: string, frameId: number): Promise<DebugToolEvaluateResult>;
  variables(variablesReference: number): Promise<DebugToolVariablesResult>;
  breakpoints(input: {
    workspacePath: string;
    op: DebugToolBreakpointOp;
  }): Promise<DebugToolBreakpointsResult>;
};

let configuredPort: DebugControlPort | null = null;

export function configureDebugControl(port: DebugControlPort | null): void {
  configuredPort = port;
}

export function getConfiguredDebugControl(): DebugControlPort | null {
  return configuredPort;
}

export function resolveDebugControl(context: {
  debugControl?: DebugControlPort;
}): DebugControlPort | null {
  return context.debugControl ?? configuredPort;
}

export function emptyDebugSnapshot(): DebugToolSnapshot {
  return { workspacePath: "", status: "idle", threads: [], stack: [], locals: [], targets: [], console: [] };
}

export type DebugToolArguments = JsonObject & {
  action?: string;
  path?: string;
  line?: number;
  condition?: string;
  enabled?: boolean;
  frame_id?: number;
  thread_id?: number;
  target_id?: string;
  expression?: string;
  variables_reference?: number;
  workspace_id?: string;
  workspace_path?: string;
  build_id?: string;
  auto_build?: boolean;
  wait_ms?: number;
};
