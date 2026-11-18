import type { JsonObject } from "../session/types.js";

export type DevTaskRunStatus =
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled"
  | "spawn-error";

export type DevTaskRunSnapshot = {
  runId: string;
  task: string;
  workspacePath: string;
  command: string;
  status: DevTaskRunStatus;
  exitCode: number | null;
  startedAt: number;
  durationMs: number | null;
  buffer: string;
  bufferTruncated: boolean;
  failureHint: string | null;
};

export type DevTaskListedTask = { id: string; command: string };

export type DevTaskRunnerPort = {
  run(input: {
    workspacePath: string;
    task: string;
  }): Promise<
    | { ok: true; runId: string; command: string }
    | { ok: false; message: string; runId?: string }
  >;
  listTasks(workspacePath: string): Promise<
    { ok: true; tasks: DevTaskListedTask[] } | { ok: false; message: string }
  >;
  awaitRun(runId: string): Promise<DevTaskRunSnapshot | null>;
  snapshot(runId: string): DevTaskRunSnapshot | null;
  state(workspacePath: string): {
    active: DevTaskRunSnapshot[];
    last: Record<string, DevTaskRunSnapshot>;
  };
  stop(runId: string): boolean;
};

let configuredRunner: DevTaskRunnerPort | null = null;

export function configureDevTaskRunner(port: DevTaskRunnerPort | null): void {
  configuredRunner = port;
}

export function getConfiguredDevTaskRunner(): DevTaskRunnerPort | null {
  return configuredRunner;
}

export function resolveDevTaskRunner(context: {
  devTaskRunner?: DevTaskRunnerPort;
}): DevTaskRunnerPort | null {
  return context.devTaskRunner ?? configuredRunner;
}

export type DevTaskToolArguments = JsonObject & {
  action?: string;
  task?: string;
  run_id?: string;
  workspace_id?: string;
  workspace_path?: string;
  wait?: boolean;
  wait_ms?: number;
};
