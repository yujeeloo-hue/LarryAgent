/**
 * Dev Mode task runner port — the structural slice of main/devTasks.ts that
 * `run_dev_task` needs. Kept free of Electron imports so the tool (and its
 * node:test suite) runs in a plain Node host.
 *
 * The live implementation is wired once from main/index.ts at IPC startup;
 * `ToolExecuteContext.devTaskRunner` may override it per turn (tests, custom
 * hosts). Headless agentd has no runner — the tool then reports unavailability
 * instead of silently doing nothing.
 */
import type { JsonObject } from "../session/types.js";

export type DevTaskRunStatus =
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled"
  | "spawn-error";

/** Terminal (or still-running) view of one task run. */
export type DevTaskRunSnapshot = {
  runId: string;
  task: string;
  workspacePath: string;
  command: string;
  status: DevTaskRunStatus;
  exitCode: number | null;
  startedAt: number;
  durationMs: number | null;
  /** Ring buffer of combined stdout/stderr (already capped by the runner). */
  buffer: string;
  bufferTruncated: boolean;
  /** One-line failure hint for failed builds (UBT), else null. */
  failureHint: string | null;
};

export type DevTaskListedTask = { id: string; command: string };

export type DevTaskRunnerPort = {
  /** Start a configured task. never throws for a missing task / active run. */
  run(input: {
    workspacePath: string;
    task: string;
  }): Promise<
    | { ok: true; runId: string; command: string }
    | { ok: false; message: string; runId?: string }
  >;
  /** Available task ids + commands (file tasks + synthetic Unreal build). */
  listTasks(workspacePath: string): Promise<
    { ok: true; tasks: DevTaskListedTask[] } | { ok: false; message: string }
  >;
  /** Resolve when the run reaches a terminal status. null = unknown/pruned. */
  awaitRun(runId: string): Promise<DevTaskRunSnapshot | null>;
  /** Non-blocking snapshot of one run. null = unknown/pruned. */
  snapshot(runId: string): DevTaskRunSnapshot | null;
  /** Active runs + last run per task for one workspace. */
  state(workspacePath: string): {
    active: DevTaskRunSnapshot[];
    last: Record<string, DevTaskRunSnapshot>;
  };
  /** Abort a running task's process group. false = not running / unknown. */
  stop(runId: string): boolean;
};

/** Process-wide runner (Electron main). Null on hosts without Dev Mode. */
let configuredRunner: DevTaskRunnerPort | null = null;

export function configureDevTaskRunner(port: DevTaskRunnerPort | null): void {
  configuredRunner = port;
}

export function getConfiguredDevTaskRunner(): DevTaskRunnerPort | null {
  return configuredRunner;
}

/** Effective port for one tool call (context override wins). */
export function resolveDevTaskRunner(context: {
  devTaskRunner?: DevTaskRunnerPort;
}): DevTaskRunnerPort | null {
  return context.devTaskRunner ?? configuredRunner;
}

/** Exported for argument-shape checks in tests / future callers. */
export type DevTaskToolArguments = JsonObject & {
  action?: string;
  task?: string;
  run_id?: string;
  workspace_id?: string;
  workspace_path?: string;
  wait?: boolean;
  wait_ms?: number;
};
