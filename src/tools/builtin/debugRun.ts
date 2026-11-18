import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  ToolDefinition,
  ToolExecuteResult,
  ToolHandler,
} from "../types.js";
import {
  abortIfSignaled,
  cancelledResult,
  failureResult,
  textResult,
} from "../pathUtil.js";
import {
  debugPort,
  describeSnapshot,
  isToolResult,
  resolveDebugWorkspace,
} from "./debugToolSupport.js";

const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;

export const debugRunDefinition: ToolDefinition = {
  name: "debug_run",
  description:
    "Start, stop or inspect a debug session for a workspace. Switches to Dev Mode first (idempotent; an open " +
    "workbench is reused) and drives the same session manager as the Debug button: project type is auto-detected " +
    "(Unreal .uproject, Electron, Node web app) and that workspace's stored breakpoints are planted. " +
    "action=start (default) waits up to wait_ms and returns status, stop reason, stack and locals; a first Unreal run " +
    "may compile DebugGame and return status=building — follow up with action=status. " +
    "action=stop ends the session (and a debuggee it launched). action=status reports the session. " +
    "Breakpoints: debug_breakpoints; stepping/variables: debug_step / debug_inspect. " +
    "Target another project with workspace_id (CoCo) or workspace_path; omit both for this session.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop", "status"],
        description:
          "start (default) = launch and attach; stop = end the session; status = report it.",
      },
      build_id: {
        type: "string",
        description:
          "start only — Unreal build/config id to debug (from the workspace list). Omit for auto-detection.",
      },
      auto_build: {
        type: "boolean",
        description:
          "start only — compile DebugGame Editor first when the build gate is closed (default true).",
      },
      wait_ms: {
        type: "integer",
        description:
          "start only — how long to wait for interactive (default 120000, max 600000); only the wait stops, the start keeps going.",
      },
      workspace_id: {
        type: "string",
        description:
          "CoCo: other in-scope project (id or name); ignored on ordinary sessions.",
      },
      workspace_path: {
        type: "string",
        description:
          "Project root path; outside this workspace needs Bypass permissions.",
      },
    },
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

function clampWaitMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(Math.floor(raw), MAX_WAIT_MS);
}

export const debugRunHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const action =
    typeof args.action === "string" && args.action ? args.action : "start";
  if (!["start", "stop", "status"].includes(action)) {
    return failureResult(
      'action must be one of "start", "stop", "status".',
      ToolReturnCode.InvalidArguments,
    );
  }

  const port = debugPort(context);
  if (isToolResult(port)) return port;

  const target = resolveDebugWorkspace(args, context);
  if (isToolResult(target)) return target;

  const ensured = await port.ensureDevMode();
  if (!ensured.ok) {
    return failureResult(
      `Dev Mode could not be entered — ${ensured.message}`,
      ToolReturnCode.GenericFailure,
    );
  }

  if (action === "status") {
    return textResult(describeSnapshot(port.state()), ToolReturnCode.Success);
  }

  if (action === "stop") {
    const stopped = await port.stop();
    if (!stopped.ok) {
      return failureResult(
        `Stop failed — ${stopped.message ?? "the debugger did not answer"}`,
        ToolReturnCode.GenericFailure,
      );
    }
    return textResult(
      `Stopped the debug session.\n${describeSnapshot(port.state(), { stack: false, locals: false })}`,
      ToolReturnCode.Success,
    );
  }

  const waitMs = clampWaitMs(args.wait_ms);
  const buildId = typeof args.build_id === "string" ? args.build_id.trim() : "";
  const autoBuild =
    typeof args.auto_build === "boolean" ? args.auto_build : undefined;

  const started: Awaited<ReturnType<typeof port.start>> = await port.start({
    workspacePath: target.path,
    ...(buildId ? { buildId } : {}),
    ...(autoBuild !== undefined ? { autoBuild } : {}),
    waitMs,
  });

  if (context.signal?.aborted) {
    return cancelledResult(
      "Cancelled while starting the debug session. The start keeps running — use debug_run action=status.",
    );
  }

  if (!started.ok) {
    const detail = started.snapshot
      ? `\n${describeSnapshot(started.snapshot, { stack: false })}`
      : "";
    const message = `Debug could not start — ${started.message}`;
    return started.cancelled
      ? failureResult(`${message}${detail}`, ToolReturnCode.Cancelled)
      : failureResult(`${message}${detail}`, ToolReturnCode.GenericFailure);
  }

  const body = describeSnapshot(started.snapshot);
  if (started.pending) {
    return textResult(
      `Debug is still preparing after ${waitMs}ms — only the wait stopped, the start keeps running.\n` +
        `${body}\n` +
        "Call debug_run action=status to follow up; a first Unreal run compiles DebugGame before attaching, " +
        "which can take tens of minutes.",
      ToolReturnCode.Success,
    );
  }
  return textResult(`Debug session is up.\n${body}`, ToolReturnCode.Success);
};

export type { ToolExecuteResult };
