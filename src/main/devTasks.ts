/**
 * Dev Mode task runner — the Build/Run buttons in the outline title row.
 *
 * Tasks come from `.larry/tasks.json` (devTaskConfig.ts); execution reuses
 * the shared execShellProcess core (timeout, process-group kill, streaming
 * tap — same guarantees as the agent run_shell path). Runs start from the
 * buttons, /build / /run slash commands, or the agent's run_dev_task tool
 * (the dev_tasks tool only writes config). A null webContents means headless
 * execution: output is still buffered for replay, but no live UI events.
 *
 * Streaming follows the terminalIpc.ts pattern: per-run ring buffer so a
 * remounted output panel can replay recent output; live chunks go to the
 * originating webContents. UBT DebugGame logs are thousands of compile
 * lines — the live cap must not freeze the Build tab mid-run.
 */
import { randomUUID } from "node:crypto";
import { ipcMain, shell, type WebContents } from "electron";
import { execShellProcess } from "../tools/shellExec.js";
import { readEffectiveDevTasks } from "./devTaskResolve.js";
import type { DevTaskDef } from "./devTaskConfig.js";
import {
  createUbtProgressParser,
  estimateEtaMs,
  isTailLinking,
  rollingActionsPerSecond,
  type UbtBuildPhase,
  type UbtProgressParser,
  type UbtRateSample,
} from "../unreal/buildProgress.js";
import { buildAllowsLaunch, ubtFailureHint, type BuildGate } from "../unreal/ubtLog.js";

/** Ring buffer per finished/running run — panel replay source. */
const RING_BUFFER_CHARS = 1_048_576;
/**
 * Live-stream cap per run. 200k froze UBT DebugGame around ~1k/6k compiles;
 * 8MB covers a verbose first Editor build with headroom.
 */
const MAX_STREAM_CHARS = 8_000_000;
/** Finished runs kept for replay; older are dropped. */
const KEEP_FINISHED_RUNS = 12;

export type DevTaskRunStatus =
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled"
  | "spawn-error";

/** `devtask:config` reply — ids + commands for button enable/tooltips. */
export type DevTaskConfigEntry = {
  id: string;
  command: string;
  origin?: "file" | "unreal";
};
export type DevTaskConfigQueryResult =
  | {
      ok: true;
      tasks: DevTaskConfigEntry[];
      unrealError?: string | null;
      debugSupported?: boolean;
      debugKind?: "unreal" | "electron" | "web" | null;
    }
  | { ok: false; message: string };

/** Live output chunk event (`devtask:output`). */
export type DevTaskOutputEvent = {
  runId: string;
  task: string;
  workspacePath: string;
  stream: "stdout" | "stderr";
  text: string;
};

/** UBT build progress — `devtask:progress` event + snapshot replay field. */
export type DevTaskProgressSnapshot = {
  phase: UbtBuildPhase;
  totalActions: number | null;
  doneActions: number | null;
  currentAction: string | null;
  /** Rolling ~30s window rate; null until ≥2s of forward progress. */
  actionsPerSecond: number | null;
  /** Smoothed estimate; null while linking (single actions skew it). */
  etaMs: number | null;
};

/** `devtask:progress` event payload. */
export type DevTaskProgressEvent = DevTaskProgressSnapshot & {
  runId: string;
  task: string;
  workspacePath: string;
  elapsedMs: number;
};

/** `devtask:state` reply — active runs + latest run per task (panel replay). */
export type DevTaskStateResult = {
  ok: true;
  active: DevTaskRunSnapshot[];
  last: Record<string, DevTaskRunSnapshot>;
  buildGate: BuildGate;
};

export type DevTaskRunSnapshot = {
  buildIdentity?: string;
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
  /** UBT progress at (or just after) the moment of the snapshot. */
  progress: DevTaskProgressSnapshot | null;
  /** One-line failure summary (failed builds only; ubtFailureHint). */
  failureHint: string | null;
};

type ActiveRun = DevTaskRunSnapshot & {
  engineRoot?: string;
  prepare?: RunDevTaskOptions["prepare"];
  executable?: { file: string; args: string[] };
  cwd: string;
  timeoutMs: number;
  envVars: Record<string, string>;
  /** Directory to open in the file manager after a successful exit. */
  openAfter: string | null;
  controller: AbortController;
  webContents: WebContents | null;
  streamChars: number;
  streamTruncated: boolean;
  /** UBT stdout parser — build runs only, null otherwise. */
  progressParser: UbtProgressParser | null;
  /** (done, at) samples for the rolling rate window. */
  progressSamples: UbtRateSample[];
  lastProgressEmitAt: number;
  lastProgressPhase: UbtBuildPhase | null;
};

/** runId → run (active + retained finished). */
const runs = new Map<string, ActiveRun>();
/** `${workspacePath}|${taskId}` → active runId. */
const activeByTask = new Map<string, string>();
/** `${workspacePath}|${taskId}` → latest finished runId. */
const lastByTask = new Map<string, string>();
/** FIFO of finished runIds for pruning. */
const finishedRunIds: string[] = [];
/** runId → callers awaiting that run's terminal snapshot. */
const runWaiters = new Map<string, Array<(snap: DevTaskRunSnapshot) => void>>();

function normalizedPath(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function taskKey(workspacePath: string, task: string): string {
  return `${normalizedPath(workspacePath)}|${task}`;
}

function send(webContents: WebContents | null, channel: string, payload: unknown): void {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}

function publicSnapshot(run: ActiveRun): DevTaskRunSnapshot {
  return {
    ...(run.buildIdentity ? { buildIdentity: run.buildIdentity } : {}),
    runId: run.runId,
    task: run.task,
    workspacePath: run.workspacePath,
    command: run.command,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    buffer: run.buffer,
    bufferTruncated: run.bufferTruncated,
    progress: progressSnapshot(run),
    failureHint: run.failureHint,
  };
}

/** Rate window: 30s lookback with a small guard margin for trimming. */
const RATE_WINDOW_MS = 30_000;
const RATE_TRIM_MARGIN_MS = 5_000;
/** devtask:progress emit floor — phase changes always flush immediately. */
const PROGRESS_EMIT_INTERVAL_MS = 250;

/**
 * Current progress view of a run. The tail-linking fallback (near-done +
 * few remaining) covers builds whose Link actions use a non-standard
 * description; a description match inside the parser is sticky regardless.
 */
function progressSnapshot(run: ActiveRun): DevTaskProgressSnapshot | null {
  if (!run.progressParser) return null;
  const state = run.progressParser.snapshot();
  const now = Date.now();
  const rate = rollingActionsPerSecond(run.progressSamples, RATE_WINDOW_MS, now);
  let phase = state.phase;
  if (
    phase !== "linking" &&
    state.totalActions != null &&
    state.doneActions != null &&
    isTailLinking(state.doneActions, state.totalActions)
  ) {
    phase = "linking";
  }
  const remaining =
    state.totalActions != null && state.doneActions != null
      ? state.totalActions - state.doneActions
      : null;
  const etaMs =
    phase === "linking" || remaining == null
      ? null
      : estimateEtaMs(remaining, rate ?? 0);
  return {
    phase,
    totalActions: state.totalActions,
    doneActions: state.doneActions,
    currentAction: state.currentAction,
    actionsPerSecond: rate,
    etaMs,
  };
}

/** Throttled `devtask:progress` push; force on phase transitions. */
function maybeEmitProgress(run: ActiveRun, force = false): void {
  if (!run.progressParser) return;
  const now = Date.now();
  const progress = progressSnapshot(run);
  if (!progress) return;
  const phaseChanged = progress.phase !== run.lastProgressPhase;
  if (!force && !phaseChanged && now - run.lastProgressEmitAt < PROGRESS_EMIT_INTERVAL_MS) {
    return;
  }
  run.lastProgressEmitAt = now;
  run.lastProgressPhase = progress.phase;
  send(run.webContents, "devtask:progress", {
    runId: run.runId,
    task: run.task,
    workspacePath: run.workspacePath,
    elapsedMs: now - run.startedAt,
    ...progress,
  });
}

function appendBuffer(run: ActiveRun, chunk: string): void {
  run.buffer += chunk;
  if (run.buffer.length > RING_BUFFER_CHARS) {
    run.buffer = run.buffer.slice(run.buffer.length - RING_BUFFER_CHARS);
    run.bufferTruncated = true;
  }
}

function emitOutput(run: ActiveRun, stream: "stdout" | "stderr", text: string): void {
  appendBuffer(run, text);
  // UBT progress rides stdout only — tool actions never log [n/m] to stderr.
  if (run.progressParser && stream === "stdout" && text) {
    const before = run.progressParser.snapshot().doneActions;
    run.progressParser.feed(text);
    const after = run.progressParser.snapshot().doneActions;
    const now = Date.now();
    if (after !== before && after != null) {
      run.progressSamples.push({ done: after, atMs: now });
      const cutoff = now - RATE_WINDOW_MS - RATE_TRIM_MARGIN_MS;
      while (run.progressSamples.length > 1 && run.progressSamples[0]!.atMs < cutoff) {
        run.progressSamples.shift();
      }
    }
    maybeEmitProgress(run);
  }
  if (!text) return;
  if (run.streamTruncated) return;
  const remaining = MAX_STREAM_CHARS - run.streamChars;
  if (remaining <= 0) {
    run.streamTruncated = true;
    send(run.webContents, "devtask:output", {
      runId: run.runId,
      stream: "stderr",
      text: "\n…(output truncated — see run history for the full buffer)\n",
    });
    return;
  }
  const forward = text.length > remaining ? text.slice(0, remaining) : text;
  if (text.length > remaining) run.streamTruncated = true;
  run.streamChars += forward.length;
  send(run.webContents, "devtask:output", {
    runId: run.runId,
    task: run.task,
    workspacePath: run.workspacePath,
    stream,
    text: forward,
  });
}

function pruneFinished(): void {
  while (finishedRunIds.length > KEEP_FINISHED_RUNS) {
    const drop = finishedRunIds.shift();
    if (!drop) break;
    const run = runs.get(drop);
    runs.delete(drop);
    if (run) {
      const key = taskKey(run.workspacePath, run.task);
      if (lastByTask.get(key) === drop) lastByTask.delete(key);
    }
  }
}

function finishRun(
  run: ActiveRun,
  status: DevTaskRunStatus,
  exitCode: number | null,
): void {
  run.status = status;
  run.exitCode = exitCode;
  run.durationMs = Date.now() - run.startedAt;
  if (run.task === "build" && (status === "failed" || status === "timeout")) {
    run.failureHint = ubtFailureHint(run.buffer);
  }
  // Flush any [n/m] line still held in the parser's carry buffer.
  run.progressParser?.feed("\n");
  maybeEmitProgress(run, true);
  const key = taskKey(run.workspacePath, run.task);
  activeByTask.delete(key);
  lastByTask.set(key, run.runId);
  finishedRunIds.push(run.runId);
  pruneFinished();
  const snapshot = publicSnapshot(run);
  send(run.webContents, "devtask:exit", snapshot);
  const waiters = runWaiters.get(run.runId);
  if (waiters) {
    runWaiters.delete(run.runId);
    for (const resolve of waiters) resolve(snapshot);
  }
}

/**
 * Terminal snapshot of one run — lets a caller (the Debug button's
 * build-then-launch chain) await a Build it did not start itself. Resolves
 * null when the runId is unknown or already pruned.
 */
export function awaitDevTaskRun(
  runId: string,
  signal?: AbortSignal,
): Promise<DevTaskRunSnapshot | null> {
  if (signal?.aborted) return Promise.resolve(null);
  const run = runs.get(runId);
  if (!run) return Promise.resolve(null);
  if (run.status !== "running") return Promise.resolve(publicSnapshot(run));
  return new Promise((resolve) => {
    const waiters = runWaiters.get(runId) ?? [];
    const done = (snapshot: DevTaskRunSnapshot | null) => {
      signal?.removeEventListener("abort", abort);
      const current = runWaiters.get(runId);
      if (current) { const index = current.indexOf(done); if (index >= 0) current.splice(index, 1); }
      resolve(snapshot);
    };
    const abort = () => done(null);
    signal?.addEventListener("abort", abort, { once: true });
    waiters.push(done);
    runWaiters.set(runId, waiters);
  });
}

/** Non-blocking snapshot for run_dev_task action=status; null when pruned. */
export function getDevTaskRunSnapshot(
  runId: string,
): DevTaskRunSnapshot | null {
  const run = runs.get(runId);
  return run ? publicSnapshot(run) : null;
}

async function executeRun(run: ActiveRun): Promise<void> {
  if (run.prepare) {
    emitOutput(run, "stdout", `[Larry] ${run.command} — checking build…\n`);
    try {
      const executable = await run.prepare(run.controller.signal);
      if (run.controller.signal.aborted) { finishRun(run, "cancelled", null); return; }
      run.executable = executable;
      emitOutput(run, "stdout", `[Larry] Starting ${executable.file}\n`);
    } catch (error) {
      emitOutput(run, "stderr", `${error instanceof Error ? error.message : String(error)}\n`);
      finishRun(run, run.controller.signal.aborted ? "cancelled" : "failed", null);
      return;
    }
  }
  const result = await execShellProcess({
    ...(run.executable ? { executable: run.executable } : {}),
    command: run.command,
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    signal: run.controller.signal,
    env: run.envVars,
    onOutput: (chunk, stream) => emitOutput(run, stream, chunk),
  });
  // execShellProcess resolves — never rejects — so this is the only exit path.
  switch (result.status) {
    case "done":
      if (result.exitCode !== 0 && run.task === "build") {
        emitOutput(run, "stderr", `\n${ubtFailureHint(run.buffer)}\n`);
      }
      if (result.exitCode === 0 && run.openAfter) {
        // Recorded before finishRun so the line lands in the replay buffer.
        emitOutput(run, "stdout", `\n[Larry] ${run.task} succeeded — opening ${run.openAfter}\n`);
        void shell.openPath(run.openAfter).catch((err) => {
          console.error(`[devtasks] openPath(${run.openAfter}) failed: ${err}`);
        });
      }
      finishRun(run, result.exitCode === 0 ? "done" : "failed", result.exitCode);
      return;
    case "timeout":
      emitOutput(run, "stderr", `\nTask timed out after ${Math.round(run.timeoutMs / 1000)}s\n`);
      finishRun(run, "timeout", null);
      return;
    case "cancelled":
      finishRun(run, "cancelled", null);
      return;
    case "spawn-error":
      if (result.errorMessage) {
        emitOutput(run, "stderr", `${result.errorMessage}\n`);
      }
      finishRun(run, "spawn-error", null);
      return;
  }
}

export type RunDevTaskResult =
  | { ok: true; runId: string; command: string }
  | { ok: false; message: string; runId?: string };

export type RunDevTaskOptions = {
  executable?: { file: string; args: string[] };
  definition: DevTaskDef;
  buildIdentity?: string;
  engineRoot?: string;
  prepare?: (signal: AbortSignal) => Promise<{ file: string; args: string[] }>;
};

export async function runDevTask(
  webContents: WebContents | null,
  workspacePath: string,
  task: string,
  options?: RunDevTaskOptions,
): Promise<RunDevTaskResult> {
  const config = await readEffectiveDevTasks(workspacePath);
  if (!config.ok) return { ok: false, message: config.message };
  const def = options?.definition ?? config.tasks[task];
  const buildIdentity = options?.buildIdentity ?? config.buildIdentity;
  const engineRoot = options?.engineRoot ?? config.engineRoot;
  if (task === "build" && !options && config.unrealError) return { ok: false, message: config.unrealError };
  if (!def) {
    const extra = config.unrealError ? ` (${config.unrealError})` : "";
    return {
      ok: false,
      message: `Task "${task}" is not defined in .larry/tasks.json — open the gear menu to configure${extra}`,
    };
  }

  const key = taskKey(workspacePath, task);
  if (task === "build" && engineRoot) {
    const active = [...runs.values()].find(r => r.status === "running" && r.task === "build" && r.engineRoot && normalizedPath(r.engineRoot) === normalizedPath(engineRoot));
    if (active) return { ok: false, message: "A build is already running for this engine. Wait for it to finish and try again", runId: active.runId };
  }
  const activeId = activeByTask.get(key);
  if (activeId) {
    const active = runs.get(activeId);
    if (active) {
      return {
        ok: false,
        message: `Task "${task}" is already running`,
        runId: activeId,
      };
    }
    activeByTask.delete(key);
  }

  const runId = randomUUID();
  const run: ActiveRun = {
    ...(options?.executable ? { executable: options.executable } : {}),
    ...(buildIdentity ? { buildIdentity } : {}),
    ...(engineRoot ? { engineRoot } : {}),
    ...(options?.prepare ? { prepare: options.prepare } : {}),
    runId,
    task,
    workspacePath,
    command: def.command,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    durationMs: null,
    buffer: "",
    bufferTruncated: false,
    progress: null,
    failureHint: null,
    cwd: def.cwd,
    timeoutMs: def.timeoutMs,
    envVars: def.env,
    openAfter: def.openAfter ?? null,
    controller: new AbortController(),
    webContents,
    streamChars: 0,
    streamTruncated: false,
    // UBT progress parsing is Unreal-only: non-Unreal builds (npm scripts,
    // electron-builder, …) never emit [n/m] action lines, and both progress
    // surfaces (conversation card + Dev Mode strip) key off progress frames —
    // no parser → no frames → nothing mounts.
    progressParser:
      task === "build" && config.debugKind === "unreal"
        ? createUbtProgressParser()
        : null,
    progressSamples: [],
    lastProgressEmitAt: 0,
    lastProgressPhase: null,
  };
  runs.set(runId, run);
  activeByTask.set(key, runId);
  // First progress frame right away so a card can mount in analyzing phase.
  maybeEmitProgress(run, true);
  void executeRun(run);
  return { ok: true, runId, command: def.command };
}

export function stopDevTask(runId: string): { ok: boolean } {
  const run = runs.get(runId);
  if (!run || run.status !== "running") return { ok: false };
  run.controller.abort();
  return { ok: true };
}

export function getDevTaskState(workspacePath: string, buildIdentity?: string): DevTaskStateResult {
  const active: DevTaskRunSnapshot[] = [];
  const last: Record<string, DevTaskRunSnapshot> = {};
  const wsNorm = normalizedPath(workspacePath);
  for (const run of runs.values()) {
    if (normalizedPath(run.workspacePath) !== wsNorm) continue;
    if (run.status === "running") active.push(publicSnapshot(run));
  }
  for (const [key, runId] of lastByTask) {
    if (!key.startsWith(`${wsNorm}|`)) continue;
    const run = runs.get(runId);
    if (run) last[key.slice(wsNorm.length + 1)] = publicSnapshot(run);
  }
  if (buildIdentity) {
    delete last.build;
    for (const run of runs.values()) if (normalizedPath(run.workspacePath) === wsNorm && run.task === "build" && run.buildIdentity === buildIdentity && run.status !== "running") {
      if (!last.build || last.build.startedAt < run.startedAt) last.build = publicSnapshot(run);
    }
  }
  return { ok: true, active, last, buildGate: buildAllowsLaunch(last.build) };
}

/**
 * Dev task IPC — Build/Run execution + state for the outline title-row
 * buttons and the editor-column output panel.
 */
export function registerDevTaskIpc(): void {
  ipcMain.handle("devtask:config", async (_event, workspacePath: unknown) => {
    const ws = typeof workspacePath === "string" ? workspacePath : "";
    if (!ws.trim()) return { ok: false, message: "workspacePath is required" };
    const config = await readEffectiveDevTasks(ws);
    if (!config.ok) return { ok: false, message: config.message };
    return {
      ok: true,
      unrealError: config.unrealError,
      debugSupported: config.debugSupported,
      debugKind: config.debugKind,
      tasks: Object.entries(config.tasks).map(([id, def]) => {
        const origin = config.origins[id];
        return origin
          ? { id, command: def.command, origin }
          : { id, command: def.command };
      }),
    };
  });

  ipcMain.handle(
    "devtask:run",
    async (
      event,
      workspacePath: unknown,
      task: unknown,
    ): Promise<RunDevTaskResult | { ok: false; message: string }> => {
      const ws = typeof workspacePath === "string" ? workspacePath : "";
      const taskId = typeof task === "string" ? task : "";
      if (!ws.trim() || !taskId.trim()) {
        return { ok: false, message: "workspacePath and task are required" };
      }
      return runDevTask(event.sender, ws, taskId);
    },
  );

  ipcMain.handle("devtask:stop", (_event, runId: unknown) => {
    return stopDevTask(typeof runId === "string" ? runId : "");
  });

  ipcMain.handle("devtask:state", (_event, workspacePath: unknown) => {
    const ws = typeof workspacePath === "string" ? workspacePath : "";
    return getDevTaskState(ws);
  });
}
