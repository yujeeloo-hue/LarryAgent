import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  cancelledResult,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { DebugToolCommand } from "../debugControlPort.js";
import {
  debugPort,
  describeSnapshot,
  formatConsole,
  formatLocals,
  formatLocation,
  formatStack,
  isToolResult,
  resolveDebugWorkspace,
} from "./debugToolSupport.js";

const DEFAULT_WAIT_MS = 20_000;
const MAX_WAIT_MS = 300_000;

const COMMANDS: Record<string, DebugToolCommand> = {
  continue: "continue",
  pause: "pause",
  next: "next",
  step_in: "stepIn",
  step_out: "stepOut",
};

export const debugStepDefinition: ToolDefinition = {
  name: "debug_step",
  description:
    "Advance the active debug session: continue, pause, step over/into/out. " +
    "Switches to Dev Mode first (idempotent), drives the same session manager as the Debug panel buttons, " +
    "waits up to wait_ms and returns the stop reason, top frame, stack and locals — no polling. " +
    "next/step_in/step_out/continue need a paused session; if it keeps running you get running plus the console " +
    "tail — check with debug_run action=status.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["continue", "pause", "next", "step_in", "step_out"],
        description:
          "continue = resume to the next breakpoint/exception; pause = suspend the target; next = step over; step_in / step_out = into / out of the call.",
      },
      wait_ms: {
        type: "integer",
        description:
          "How long to wait for the stop (default 20000, max 300000). Only the wait stops.",
      },
      workspace_id: {
        type: "string",
        description: "CoCo: other in-scope project (id or name).",
      },
      workspace_path: {
        type: "string",
        description: "Project root path. Defaults to this session.",
      },
    },
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

export const debugStepHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const action = typeof args.action === "string" ? args.action.trim() : "";
  const command = COMMANDS[action];
  if (!command) {
    return failureResult(
      'action must be one of "continue", "pause", "next", "step_in", "step_out".',
      ToolReturnCode.InvalidArguments,
    );
  }

  const port = debugPort(context);
  if (isToolResult(port)) return port;

  const target = resolveDebugWorkspace(args, context);
  if (isToolResult(target)) return target;

  const rawWait = typeof args.wait_ms === "number" ? args.wait_ms : 0;
  const waitMs =
    Number.isFinite(rawWait) && rawWait > 0
      ? Math.min(Math.floor(rawWait), MAX_WAIT_MS)
      : DEFAULT_WAIT_MS;

  const ensured = await port.ensureDevMode();
  if (!ensured.ok) {
    return failureResult(
      `Dev Mode could not be entered — ${ensured.message}`,
      ToolReturnCode.GenericFailure,
    );
  }

  const before = port.state();
  if (before.status === "idle") {
    return failureResult(
      "No debug session is active — start one with debug_run action=start.",
      ToolReturnCode.NotFound,
    );
  }
  if (command === "pause") {
    if (before.status !== "running") {
      return failureResult(
        `pause needs a running target (status is ${before.status}).`,
        ToolReturnCode.InvalidArguments,
      );
    }
  } else if (before.status !== "stopped") {
    return failureResult(
      `${action} needs a paused process (status is ${before.status}). ` +
        "Wait for a stop with debug_run action=status, or use action=pause / action=continue.",
      ToolReturnCode.InvalidArguments,
    );
  }

  const ran = await port.command(command);
  if (!ran.ok) {
    return failureResult(
      `Debug command "${action}" failed — ${ran.message ?? "the debugger did not answer"}`,
      ToolReturnCode.GenericFailure,
    );
  }

  const snapshot = await port.waitForStatus({
    statuses: ["stopped", "error", "idle"],
    timeoutMs: waitMs,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (context.signal?.aborted) {
    return cancelledResult(
      "Cancelled while waiting for the next stop. The command itself was delivered — use debug_run action=status.",
    );
  }

  if (snapshot.status === "stopped") {
    return textResult(
      [
        `${action} → stopped`,
        `reason: ${snapshot.stopped?.reason ?? "unknown"}` +
          (snapshot.stopped?.description ?? snapshot.stopped?.text
            ? ` — ${snapshot.stopped.description ?? snapshot.stopped.text}`
            : ""),
        `location: ${formatLocation(snapshot)}`,
        ...formatStack(snapshot, 10),
        ...formatLocals(snapshot),
      ].join("\n"),
      ToolReturnCode.Success,
    );
  }
  if (snapshot.status === "error") {
    return failureResult(
      `${action} failed inside the debugger.\n${describeSnapshot(snapshot, { stack: false })}`,
      ToolReturnCode.GenericFailure,
    );
  }
  if (snapshot.status === "idle") {
    return textResult(
      `${action} → the debug session ended (target exited or was stopped).\n` +
        `${describeSnapshot(snapshot, { stack: false, locals: false })}`,
      ToolReturnCode.Success,
    );
  }
  return textResult(
    [
      `${action} → still ${snapshot.status} after ${waitMs}ms (only the wait stopped)`,
      ...formatConsole(snapshot),
      "Call debug_run action=status to check again.",
    ].join("\n"),
    ToolReturnCode.Success,
  );
};
