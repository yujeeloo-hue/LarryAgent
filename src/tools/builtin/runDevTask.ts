/**
 * run_dev_task — let the agent actually build, run and deploy a workspace.
 *
 * `dev_tasks` only reads/writes .larry/tasks.json; this tool executes those
 * tasks through the same main-process runner as the Dev Mode Build / Run /
 * Deploy buttons (per-task timeout/env/platform overrides/openAfter, streamed
 * output, UBT progress). Unlike the buttons it is synchronous by default:
 * the model gets the exit code and the output tail back and can iterate on a
 * failed build. Long-lived `run` tasks use wait=false, then action=status /
 * action=stop with the returned run_id.
 *
 * The runner is a structurally typed port (devTaskRunnerPort.ts) — no Electron
 * import here. main/index.ts wires the live runner at IPC startup.
 */
import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  JsonObject,
  ToolDefinition,
  ToolExecuteContext,
  ToolExecuteResult,
  ToolHandler,
} from "../types.js";
import {
  abortIfSignaled,
  cancelledResult,
  displayPath,
  failureResult,
  resolveToolPath,
  textResult,
  workspaceRootAbsolute,
} from "../pathUtil.js";
import {
  resolveDevTaskRunner,
  type DevTaskRunSnapshot,
  type DevTaskRunnerPort,
} from "../devTaskRunnerPort.js";

/** Output tail returned to the model (runner's own ring buffer is ~1MB). */
const MAX_TAIL_CHARS = 16_000;
/** Upper bound on wait_ms — matches the task config's 8h timeout cap. */
const MAX_WAIT_MS = 28_800_000;
/** Task ids in .larry/tasks.json use this shape (see devTaskConfig.ts). */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

const PORT_MISSING =
  "Dev Mode task execution is unavailable in this host (no dev task runner). " +
  "Use exec_command for one-off commands, or run the task from the Dev Mode buttons.";

export const runDevTaskDefinition: ToolDefinition = {
  name: "run_dev_task",
  description:
    "Build, run or deploy a workspace by executing a Dev Mode task defined in .larry/tasks.json " +
    "(ids: build, run, deploy, or any custom task). Uses the exact same runner as the Dev Mode " +
    "buttons — per-task timeout, env, mac/win overrides, openAfter and streaming output. " +
    "action=run (default) waits for the task to finish and returns its exit code plus the output " +
    "tail, so you can fix a failed build and retry. Long-lived app processes (task=run) should " +
    "use wait=false and then action=status / action=stop with the returned run_id. " +
    "action=list shows the tasks available in a workspace; configure them with dev_tasks. " +
    "Target another project with workspace_id (CoCo, by id or name, subject to project exclusions) " +
    "or workspace_path (absolute project root; outside the current workspace requires Bypass " +
    "permissions). Omit both to use this session's workspace. " +
    "CAUTION: task=deploy really executes the configured publish/release script — confirm with " +
    "the user via ask_user before deploying unless they explicitly asked for it.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["run", "list", "status", "stop"],
        description:
          "run = execute a task (default); list = show available tasks; status = inspect a run or the workspace's active/last runs; stop = abort a running task.",
      },
      task: {
        type: "string",
        description:
          'Task id from .larry/tasks.json — typically "build", "run" or "deploy". Required for action=run; optional filter for status/stop.',
      },
      run_id: {
        type: "string",
        description:
          "Run id returned by action=run. Used by status (exact run) and stop (defaults to the active run of `task` when omitted).",
      },
      workspace_id: {
        type: "string",
        description:
          "CoCo only: id or name of another in-scope project to run the task in. Ignored on ordinary sessions (returns an error).",
      },
      workspace_path: {
        type: "string",
        description:
          "Absolute path of the project root to run the task in. Paths outside this session's workspace require Bypass permissions and must pass the host's path boundary.",
      },
      wait: {
        type: "boolean",
        description:
          "run only — wait for the task to finish and return its result (default true). Use false for servers / dev processes that never exit.",
      },
      wait_ms: {
        type: "integer",
        description:
          "run only — stop waiting after this many ms and return the still-running run_id (0 or omitted = wait until the task exits; max 28800000). The task keeps running.",
      },
    },
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

/** Resolve the target workspace root from the optional scoping arguments. */
function resolveWorkspace(
  args: JsonObject,
  context: ToolExecuteContext,
): { path: string } | ToolExecuteResult {
  const byId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  const byPath = typeof args.workspace_path === "string" ? args.workspace_path.trim() : "";
  if (byId && byPath) {
    return failureResult(
      "Specify either workspace_id or workspace_path, not both.",
      ToolReturnCode.InvalidArguments,
    );
  }
  const current = context.workspacePath?.trim() ?? "";

  if (byId) {
    if (!context.cocoProjectPath) {
      return failureResult(
        "workspace_id is only available to CoCo; omit it to use this session's workspace, or pass workspace_path.",
        ToolReturnCode.InvalidArguments,
      );
    }
    const workspaces = context.listWorkspaces?.() ?? [];
    const needle = byId.toLowerCase();
    const match = workspaces.find(
      (w) => w.id === byId || w.name.trim().toLowerCase() === needle,
    );
    if (!match && workspaces.length > 0) {
      const available = workspaces.map((w) => `"${w.name}" (${w.id})`).join(", ");
      return failureResult(
        `Unknown workspace "${byId}". Available: ${available}.`,
        ToolReturnCode.NotFound,
      );
    }
    let root: string;
    try {
      root = context.cocoProjectPath(match?.id ?? byId);
    } catch (error) {
      return failureResult(
        error instanceof Error ? error.message : String(error),
        ToolReturnCode.NotFound,
      );
    }
    return { path: workspaceRootAbsolute(root) };
  }

  if (byPath) {
    if (!current) {
      return failureResult(
        "No workspace is active for this session.",
        ToolReturnCode.NotFound,
      );
    }
    const resolved = resolveToolPath(byPath, {
      workspacePath: workspaceRootAbsolute(current),
      allowOutsideWorkspace: context.fullPermissionsEnabled === true,
    });
    if (!resolved.ok) {
      return failureResult(resolved.reason, resolved.returnCode);
    }
    try {
      context.assertPath?.(resolved.path.absolute);
    } catch (error) {
      return failureResult(
        error instanceof Error ? error.message : String(error),
        ToolReturnCode.PermissionDenied,
      );
    }
    return { path: resolved.path.absolute };
  }

  if (!current) {
    return failureResult(
      "No workspace is active for this session.",
      ToolReturnCode.NotFound,
    );
  }
  return { path: workspaceRootAbsolute(current) };
}

function tail(buffer: string): string {
  if (!buffer) return "(no output)";
  if (buffer.length <= MAX_TAIL_CHARS) return buffer;
  return `…(earlier output omitted)\n${buffer.slice(buffer.length - MAX_TAIL_CHARS)}`;
}

function duration(snap: DevTaskRunSnapshot): string {
  const ms = snap.durationMs ?? (snap.status === "running" ? Date.now() - snap.startedAt : null);
  if (ms === null) return "duration unknown";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatRun(snap: DevTaskRunSnapshot, prefix = ""): string {
  const lines = [
    `${prefix}$ ${snap.command}`,
    `${prefix}workspace ${displayPath(snap.workspacePath)} · task ${snap.task} · run ${snap.runId}`,
    `${prefix}status ${snap.status} · exit ${snap.exitCode ?? "n/a"} · ${duration(snap)}`,
  ];
  if (snap.failureHint) lines.push(`${prefix}hint: ${snap.failureHint}`);
  if (snap.bufferTruncated) {
    lines.push(`${prefix}(runner ring buffer truncated — showing the tail)`);
  }
  lines.push(`${prefix}--- output ---`, tail(snap.buffer));
  return lines.join("\n");
}

function terminalReturnCode(snap: DevTaskRunSnapshot): number {
  switch (snap.status) {
    case "done":
    case "running":
      return ToolReturnCode.Success;
    case "failed":
    case "spawn-error":
      return ToolReturnCode.GenericFailure;
    case "timeout":
      return ToolReturnCode.Timeout;
    case "cancelled":
      return ToolReturnCode.Cancelled;
  }
}

type WaitOutcome =
  | { kind: "done"; snap: DevTaskRunSnapshot | null }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

/** Race the runner's completion against wait_ms and the tool-call abort. */
async function waitForRun(
  port: DevTaskRunnerPort,
  runId: string,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  const done: Promise<WaitOutcome> = port
    .awaitRun(runId)
    .then((snap) => ({ kind: "done", snap }) as WaitOutcome)
    .catch((err) => ({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    }) as WaitOutcome);
  const timeout: Promise<WaitOutcome> = new Promise((resolve) => {
    if (waitMs > 0) {
      timer = setTimeout(() => resolve({ kind: "timeout" }), waitMs);
    }
  });
  const cancelled: Promise<WaitOutcome> = new Promise((resolve) => {
    if (!signal) return;
    const onAbort = () => resolve({ kind: "cancelled" });
    if (signal.aborted) {
      resolve({ kind: "cancelled" });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([done, timeout, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort();
  }
}

function snapshotLine(snap: DevTaskRunSnapshot): string {
  return `- ${snap.task} · run ${snap.runId} · ${snap.status} · exit ${snap.exitCode ?? "n/a"} · ${duration(snap)} · ${snap.command}`;
}

export const runDevTaskHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const action = typeof args.action === "string" && args.action ? args.action : "run";
  if (!["run", "list", "status", "stop"].includes(action)) {
    return failureResult(
      'action must be one of "run", "list", "status", "stop".',
      ToolReturnCode.InvalidArguments,
    );
  }
  const port = resolveDevTaskRunner(context);
  if (!port) return failureResult(PORT_MISSING, ToolReturnCode.GenericFailure);

  const target = resolveWorkspace(args, context);
  if ("returnCode" in target) return target;
  const workspacePath = target.path;

  const taskArg = typeof args.task === "string" ? args.task.trim() : "";
  const runIdArg = typeof args.run_id === "string" ? args.run_id.trim() : "";

  // ---------------------------------------------------------------- list
  if (action === "list") {
    const listed = await port.listTasks(workspacePath);
    if (!listed.ok) return failureResult(listed.message, ToolReturnCode.NotFound);
    if (listed.tasks.length === 0) {
      return textResult(
        `Workspace ${displayPath(workspacePath)} has no Dev Mode tasks. ` +
          "Configure them with dev_tasks (action=set, ids build / run / deploy).",
        ToolReturnCode.Success,
      );
    }
    const lines = listed.tasks.map((t) => `- ${t.id}: ${t.command}`);
    return textResult(
      `Workspace ${displayPath(workspacePath)} — ${listed.tasks.length} task(s):\n${lines.join("\n")}\n` +
        'Use action=run with task="<id>"; ids build / run / deploy map to the Dev Mode buttons.',
      ToolReturnCode.Success,
    );
  }

  // -------------------------------------------------------------- status
  if (action === "status") {
    if (runIdArg) {
      const snap = port.snapshot(runIdArg);
      if (!snap) {
        return failureResult(
          `Unknown or pruned run "${runIdArg}". Use action=status with task=<id> to see active/last runs.`,
          ToolReturnCode.NotFound,
        );
      }
      return textResult(formatRun(snap), terminalReturnCode(snap));
    }
    const state = port.state(workspacePath);
    const active = taskArg ? state.active.filter((s) => s.task === taskArg) : state.active;
    const last = taskArg
      ? Object.entries(state.last).filter(([id]) => id === taskArg)
      : Object.entries(state.last);
    const lines = [`Workspace ${displayPath(workspacePath)} · status`];
    lines.push(
      active.length > 0
        ? `active:\n${active.map(snapshotLine).join("\n")}`
        : `active: (none${taskArg ? ` for task "${taskArg}"` : ""})`,
    );
    lines.push(
      last.length > 0
        ? `last:\n${last.map(([, snap]) => snapshotLine(snap)).join("\n")}`
        : `last: (none${taskArg ? ` for task "${taskArg}"` : ""})`,
    );
    return textResult(lines.join("\n"), ToolReturnCode.Success);
  }

  // ---------------------------------------------------------------- stop
  if (action === "stop") {
    let runId = runIdArg;
    if (!runId && taskArg) {
      runId =
        port.state(workspacePath).active.find((s) => s.task === taskArg)?.runId ?? "";
    }
    if (!runId) {
      return failureResult(
        "stop requires run_id (or a task with an active run).",
        ToolReturnCode.InvalidArguments,
      );
    }
    if (!port.stop(runId)) {
      return failureResult(
        `Run "${runId}" is not running (already finished, or unknown).`,
        ToolReturnCode.NotFound,
      );
    }
    return textResult(
      `Stopped run ${runId}. The process group is being killed; use action=status with run_id to see the final state.`,
      ToolReturnCode.Success,
    );
  }

  // ----------------------------------------------------------------- run
  if (!taskArg) {
    return failureResult(
      'action=run requires "task" (e.g. build, run, deploy). Use action=list to see available tasks.',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (!TASK_ID_RE.test(taskArg)) {
    return failureResult(
      `Invalid task id "${taskArg}" — use letters, digits, "-" or "_" (max 32 chars).`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const wait = typeof args.wait === "boolean" ? args.wait : true;
  const rawWaitMs = typeof args.wait_ms === "number" ? args.wait_ms : 0;
  const waitMs =
    Number.isFinite(rawWaitMs) && rawWaitMs > 0
      ? Math.min(Math.floor(rawWaitMs), MAX_WAIT_MS)
      : 0;

  const listed = await port.listTasks(workspacePath);
  if (!listed.ok) return failureResult(listed.message, ToolReturnCode.NotFound);
  if (!listed.tasks.some((t) => t.id === taskArg)) {
    const available = listed.tasks.map((t) => t.id).join(", ") || "(none)";
    return failureResult(
      `Task "${taskArg}" is not defined for ${displayPath(workspacePath)}. ` +
        `Available: ${available}. Configure it with dev_tasks (action=set).`,
      ToolReturnCode.NotFound,
    );
  }

  const started = await port.run({ workspacePath, task: taskArg });
  let runId = "";
  let command = taskArg;
  let attached = false;
  if (started.ok) {
    runId = started.runId;
    command = started.command;
  } else if (started.runId) {
    // Same task already running — attach to it instead of starting a duplicate.
    runId = started.runId;
    attached = true;
    const existing = port.snapshot(runId);
    if (existing) command = existing.command;
  } else {
    return failureResult(
      `Could not start task "${taskArg}" — ${started.message}`,
      ToolReturnCode.GenericFailure,
    );
  }

  if (!wait) {
    const snap = port.snapshot(runId);
    return textResult(
      `${attached ? "Task already running — attached to" : "Started"} task "${taskArg}" in ${displayPath(workspacePath)}\n` +
        `$ ${command}\nrun_id ${runId} · status ${snap?.status ?? "running"}\n` +
        `Use action=status with run_id to inspect, or action=stop to abort.`,
      ToolReturnCode.Success,
    );
  }

  const outcome = await waitForRun(port, runId, waitMs, context.signal);
  if (outcome.kind === "cancelled") {
    return cancelledResult(
      `Cancelled while waiting for task "${taskArg}" (run ${runId}). The task keeps running — ` +
        `use action=status / action=stop with run_id.`,
    );
  }
  if (outcome.kind === "error") {
    return failureResult(
      `Waiting for task "${taskArg}" (run ${runId}) failed — ${outcome.message}`,
      ToolReturnCode.GenericFailure,
    );
  }
  if (outcome.kind === "timeout") {
    const snap = port.snapshot(runId);
    return textResult(
      `Task "${taskArg}" (run ${runId}) is still running after ${waitMs}ms — ` +
        "the wait stopped, not the task.\n" +
        (snap ? formatRun(snap) : `$ ${command}`) +
        `\nUse action=status with run_id to check again, or action=stop to abort.`,
      ToolReturnCode.Success,
    );
  }
  if (!outcome.snap) {
    return failureResult(
      `Run ${runId} finished but its result is no longer available (pruned). ` +
        "Re-run the task with a shorter output or check the Dev Mode output panel.",
      ToolReturnCode.NotFound,
    );
  }
  const snap = outcome.snap;
  return textResult(
    `${attached ? "Attached to the already-running" : "Ran"} task "${taskArg}"\n${formatRun(snap)}`,
    terminalReturnCode(snap),
  );
};
