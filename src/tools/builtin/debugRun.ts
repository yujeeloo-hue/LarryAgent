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
    "action=start (default) cleans up the target workspace's previous debug session before launching again. " +
    "If the Dev Mode ensure request times out after 8 seconds, wait 8 seconds and retry the same call; " +
    "the debug action has not started yet. " +
    "It waits up to wait_ms for the new launch and returns status, stop reason, stack and locals; a first Unreal run " +
    "may compile DebugGame and return status=building — follow up with action=status. " +
    "action=stop ends the session (and a debuggee it launched). action=status reports the session. " +
    "Breakpoints: debug_breakpoints; stepping/variables: debug_step / debug_inspect. " +
    "start callback=true binds this session to the start attempt: it is resumed when the build finishes, " +
    "when the debugger brings the app up, and when the start fails. The binding ends with the debug session. " +
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
      callback: {
        type: "boolean",
        description:
          "start only — true binds this session to the start attempt and resumes it when the build finishes, " +
          "when the debugger brings the app up, and when the start fails; false releases that binding. " +
          "The session id comes from the tool call, never from arguments.",
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

  const callbackFlag = typeof args.callback === "boolean" ? args.callback : undefined;
  if (callbackFlag !== undefined && action !== "start") {
    return failureResult(
      '"callback" applies to action=start only.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const sessionId = (context.sessionId ?? "").trim();
  if (callbackFlag === true && !sessionId) {
    return failureResult(
      "Callback binding needs a session, and this tool call carries no session id.",
      ToolReturnCode.InvalidArguments,
    );
  }

  const port = debugPort(context);
  if (isToolResult(port)) return port;

  const target = resolveDebugWorkspace(args, context);
  if (isToolResult(target)) return target;

  const ensured = await port.ensureDevMode();
  if (!ensured.ok) {
    if (/Dev Mode did not answer "ensure" within 8000ms/i.test(ensured.message)) {
      return failureResult(
        "Dev Mode did not answer within 8 seconds. Wait 8 seconds, then retry this same debug_run call. " +
          "The debug action has not started, so the existing debug session is unchanged.",
        ToolReturnCode.GenericFailure,
      );
    }
    return failureResult(
      `Dev Mode could not be entered — ${ensured.message}`,
      ToolReturnCode.GenericFailure,
    );
  }

  if (action === "status") {
    const lines = [describeSnapshot(port.state())];
    if (sessionId) {
      const armed = await port.startCallbackState({ sessionId });
      if (armed.ok && armed.enabled) {
        lines.push("callback: armed — this session is resumed when the build finishes and when the app is up");
      }
    }
    return textResult(lines.join("\n"), ToolReturnCode.Success);
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
    ...(sessionId ? { sessionId } : {}),
    ...(callbackFlag !== undefined ? { callback: callbackFlag } : {}),
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

  const callbackNote = started.startCallbackArmed === true
    ? "\ncallback: armed for this start — this session is resumed when the build finishes, when the app is up, and on failure"
    : started.startCallbackArmed === false && callbackFlag === false
      ? "\ncallback: released"
      : "";
  const body = `${describeSnapshot(started.snapshot)}${callbackNote}`;
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
