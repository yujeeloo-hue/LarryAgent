import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import {
  debugPort,
  describeSnapshot,
  formatConsole,
  formatLocals,
  formatStack,
  formatTargets,
  isToolResult,
  resolveDebugWorkspace,
} from "./debugToolSupport.js";

const ACTIONS = [
  "stack",
  "threads",
  "targets",
  "locals",
  "variables",
  "evaluate",
  "select_frame",
  "select_thread",
] as const;

export const debugInspectDefinition: ToolDefinition = {
  name: "debug_inspect",
  description:
    "Read the active debug session: call stack, threads/targets, frame locals, a nested variable, an evaluated " +
    "expression, or switch the selected frame/thread. " +
    "Switches to Dev Mode first (idempotent); same data as the Debug panel. " +
    "stack/locals/variables/evaluate need a paused process (reach a breakpoint with debug_step first). " +
    "targets/threads also work while running, but frames and variable references die on resume " +
    "(\"Process is not paused\") — re-read the stack.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description:
          "stack (default) = frames of the selected thread; locals = selected frame; variables = expand a ref; evaluate = expression in a frame; select_frame / select_thread / targets = switch view.",
      },
      frame_id: {
        type: "integer",
        description:
          "From a previous stack call; evaluate defaults to the selected frame, then the top frame.",
      },
      thread_id: {
        type: "integer",
        description: "Thread id from action=stack/threads. Required for select_thread.",
      },
      target_id: {
        type: "string",
        description: "Electron/Web sessions only (see targets).",
      },
      expression: {
        type: "string",
        description:
          "evaluate — debugger dialect (C++ / JS), max 1000 chars.",
      },
      variables_reference: {
        type: "integer",
        description:
          "variables — the [ref N] handle next to a local or row.",
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

const NOT_PAUSED =
  "Process is not paused — start with debug_run and reach a breakpoint (debug_step action=continue), then inspect.";

export const debugInspectHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const action =
    typeof args.action === "string" && args.action ? args.action : "stack";
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
    return failureResult(
      `action must be one of ${ACTIONS.map((item) => `"${item}"`).join(", ")}.`,
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

  const snapshot = port.state();

  if (action === "targets") {
    return textResult(
      [...formatTargets(snapshot), ...formatConsole(snapshot)].join("\n"),
      ToolReturnCode.Success,
    );
  }
  if (action === "threads") {
    return textResult(
      formatTargets(snapshot).join("\n"),
      ToolReturnCode.Success,
    );
  }

  if (action === "select_frame") {
    const frameId = typeof args.frame_id === "number" ? args.frame_id : 0;
    if (!Number.isInteger(frameId) || frameId <= 0) {
      return failureResult(
        'select_frame requires "frame_id" from a previous action=stack.',
        ToolReturnCode.InvalidArguments,
      );
    }
    const selected = await port.selectFrame(frameId);
    if (!selected.ok) {
      return failureResult(
        `select_frame failed — ${selected.message ?? "the frame is no longer available"}`,
        ToolReturnCode.NotFound,
      );
    }
    const after = port.state();
    return textResult(
      [
        `selected frame ${frameId}`,
        ...formatStack(after, 10),
        ...formatLocals(after),
      ].join("\n"),
      ToolReturnCode.Success,
    );
  }

  if (action === "select_thread") {
    const threadId = typeof args.thread_id === "number" ? args.thread_id : 0;
    if (!Number.isInteger(threadId) || threadId <= 0) {
      return failureResult(
        'select_thread requires "thread_id" from action=threads.',
        ToolReturnCode.InvalidArguments,
      );
    }
    const selected = await port.selectThread(threadId);
    if (!selected.ok) {
      return failureResult(
        `select_thread failed — ${selected.message ?? "the thread is no longer available"}`,
        ToolReturnCode.NotFound,
      );
    }
    const after = port.state();
    return textResult(
      [
        `selected thread ${threadId}`,
        ...formatStack(after, 10),
        ...formatLocals(after),
      ].join("\n"),
      ToolReturnCode.Success,
    );
  }

  if (snapshot.status !== "stopped") {
    return failureResult(NOT_PAUSED, ToolReturnCode.GenericFailure);
  }

  if (action === "stack") {
    return textResult(
      [
        `location: ${snapshot.stack[0]?.file ?? "(no source)"}:${snapshot.stack[0]?.line ?? 0}`,
        ...formatStack(snapshot),
        ...formatLocals(snapshot),
      ].join("\n"),
      ToolReturnCode.Success,
    );
  }

  if (action === "locals") {
    return textResult(
      [
        `frame: ${snapshot.selectedFrameId ?? snapshot.stack[0]?.id ?? "(none)"}`,
        ...formatStack(snapshot, 5),
        ...formatLocals(snapshot),
      ].join("\n"),
      ToolReturnCode.Success,
    );
  }

  if (action === "variables") {
    const reference =
      typeof args.variables_reference === "number" ? args.variables_reference : 0;
    if (!Number.isInteger(reference) || reference <= 0) {
      return failureResult(
        'variables requires a positive "variables_reference" (the [ref N] handle next to a local).',
        ToolReturnCode.InvalidArguments,
      );
    }
    const expanded = await port.variables(reference);
    if (!expanded.ok) {
      return failureResult(
        `Expanding ref ${reference} failed — ${expanded.message}`,
        ToolReturnCode.GenericFailure,
      );
    }
    return textResult(
      [
        `ref ${reference}: ${expanded.variables.length} child value(s)`,
        ...expanded.variables.map((variable) => {
          const type = variable.type ? ` (${variable.type})` : "";
          const ref =
            variable.variablesReference > 0
              ? ` [ref ${variable.variablesReference}]`
              : "";
          return `  ${variable.name}${type} = ${variable.value}${ref}`;
        }),
      ].join("\n"),
      ToolReturnCode.Success,
    );
  }

  const expression =
    typeof args.expression === "string" ? args.expression.trim() : "";
  if (!expression) {
    return failureResult(
      'evaluate requires "expression".',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (expression.length > 1_000) {
    return failureResult(
      "expression is limited to 1000 characters.",
      ToolReturnCode.InvalidArguments,
    );
  }
  const frameId =
    typeof args.frame_id === "number" && Number.isInteger(args.frame_id)
      ? args.frame_id
      : (snapshot.selectedFrameId ?? snapshot.stack[0]?.id ?? 0);
  if (!frameId) {
    return failureResult(
      "No stack frame is available for evaluate — re-read action=stack.",
      ToolReturnCode.NotFound,
    );
  }
  const evaluated = await port.evaluate(expression, frameId);
  if (!evaluated.ok) {
    return failureResult(
      `evaluate "${expression}" failed — ${evaluated.message}`,
      ToolReturnCode.GenericFailure,
    );
  }
  return textResult(
    `frame ${frameId}: ${expression} = ${evaluated.result}` +
      `${evaluated.type ? ` (${evaluated.type})` : ""}` +
      `${evaluated.variablesReference > 0 ? `  [ref ${evaluated.variablesReference}]` : ""}`,
    ToolReturnCode.Success,
  );
};

export type { ToolExecuteResult } from "../types.js";
