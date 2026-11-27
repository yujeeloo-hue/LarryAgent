import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { DebugControlPort, DebugToolBreakpointOp } from "../debugControlPort.js";
import {
  debugPort,
  formatBreakpoints,
  isToolResult,
  resolveBreakpointFile,
  resolveDebugWorkspace,
} from "./debugToolSupport.js";

const ACTIONS = [
  "list",
  "add",
  "remove",
  "enable",
  "disable",
  "set_condition",
  "clear",
] as const;

export const debugBreakpointsDefinition: ToolDefinition = {
  name: "debug_breakpoints",
  description:
    "List or edit a workspace's breakpoints. Switches to Dev Mode first (idempotent). " +
    "add plants one (optionally conditional, optionally disabled); remove/enable/disable/set_condition " +
    "change one line; clear removes all; list reports the set. " +
    "Line numbers are 1-based and must exist in the file. " +
    "Edits persist per workspace, show in the panel and gutter and push to a running session. " +
    "add callback=true also binds that line to this session: when the debugger stops there the session is " +
    "resumed with the file:line (many sessions may bind the same line); callback=false releases it. " +
    "Only debug_run action=start honours breakpoints.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description:
          "list (default) = report; add = plant one; remove / enable / disable = one line; set_condition = set its expression; clear = all.",
      },
      path: {
        type: "string",
        description:
          "Breakpoint file (absolute or workspace-relative). Needed except list/clear.",
      },
      line: {
        type: "integer",
        description: "1-based line number. Needed except list/clear.",
      },
      condition: {
        type: "string",
        description:
          "add / set_condition — break only when this expression is true (adapter dialect, e.g. a C++ or JS expression). Empty = unconditional.",
      },
      enabled: {
        type: "boolean",
        description: "add only — plant it disabled (default true).",
      },
      callback: {
        type: "boolean",
        description:
          "add only — true binds this line to the calling session and resumes it when the debugger stops there; " +
          "false releases that binding. The session id comes from the tool call, never from arguments.",
      },
      workspace_id: {
        type: "string",
        description: "CoCo: other in-scope project (id or name).",
      },
      workspace_path: {
        type: "string",
        description:
          "Project root path the breakpoints belong to. Defaults to this session.",
      },
    },
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

export const debugBreakpointsHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const action =
    typeof args.action === "string" && args.action ? args.action : "list";
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
    return failureResult(
      `action must be one of ${ACTIONS.map((item) => `"${item}"`).join(", ")}.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const callbackFlag = typeof args.callback === "boolean" ? args.callback : undefined;
  if (callbackFlag !== undefined && action !== "add") {
    return failureResult(
      '"callback" applies to action=add only.',
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

  let op: DebugToolBreakpointOp;
  let touchedPath = "";
  let touchedLine = 0;
  if (action === "list") {
    op = { action: "list" };
  } else if (action === "clear") {
    op = { action: "clear" };
  } else {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) {
      return failureResult(
        `action=${action} requires "path".`,
        ToolReturnCode.InvalidArguments,
      );
    }
    const line = typeof args.line === "number" ? args.line : 0;
    if (!Number.isInteger(line) || line <= 0) {
      return failureResult(
        'action requires a positive integer "line" (1-based).',
        ToolReturnCode.InvalidArguments,
      );
    }
    const file = resolveBreakpointFile(rawPath, target.path, context);
    if (isToolResult(file)) return file;
    touchedPath = file.path;
    touchedLine = line;
    const condition =
      typeof args.condition === "string" ? args.condition.trim() : "";
    op =
      action === "add"
        ? {
            action: "add",
            path: file.path,
            line,
            ...(condition ? { condition } : {}),
            ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
          }
        : action === "set_condition"
          ? { action: "set_condition", path: file.path, line, condition }
          : { action: action as "remove" | "enable" | "disable", path: file.path, line };
  }

  const ensured = await port.ensureDevMode();
  if (!ensured.ok) {
    return failureResult(
      `Dev Mode could not be entered — ${ensured.message}`,
      ToolReturnCode.GenericFailure,
    );
  }

  const result = await port.breakpoints({ workspacePath: target.path, op });
  if (!result.ok) {
    return failureResult(
      `Breakpoint ${action} failed — ${result.message}`,
      ToolReturnCode.GenericFailure,
    );
  }
  const notes = await applyCallbackBinding({
    action,
    callbackFlag,
    sessionId,
    port,
    workspacePath: target.path,
    path: touchedPath,
    line: touchedLine,
  });
  const header =
    action === "list"
      ? "Workspace breakpoints"
      : `Breakpoint ${action} applied`;
  const body = [formatBreakpoints(result.breakpoints), ...notes].join("\n");
  return textResult(`${header} (${target.path})\n${body}`, ToolReturnCode.Success);
};

async function applyCallbackBinding(input: {
  action: string;
  callbackFlag: boolean | undefined;
  sessionId: string;
  port: DebugControlPort;
  workspacePath: string;
  path: string;
  line: number;
}): Promise<string[]> {
  const { action, callbackFlag, sessionId, port, workspacePath, path, line } = input;
  if (!sessionId) return [];
  try {
    if (action === "add" && callbackFlag !== undefined) {
      const reply = callbackFlag
        ? await port.bindBreakpointCallback({ workspacePath, sessionId, path, line })
        : await port.unbindBreakpointCallback({ workspacePath, sessionId, path, line });
      if (!reply.ok) return [`callback: not updated — ${reply.message ?? "unknown error"}`];
      const count = `${reply.bindings.length} line(s)`;
      return [
        callbackFlag
          ? `callback: bound — this session is resumed when ${path}:${line} stops (${count} bound here)`
          : `callback: released (${count} still bound here)`,
      ];
    }
    if (action === "remove") {
      await port.unbindBreakpointCallback({ workspacePath, sessionId, path, line });
      return [];
    }
    if (action === "clear") {
      await port.unbindBreakpointCallback({ workspacePath, sessionId });
      return [];
    }
    if (action === "list") {
      const listed = await port.listBreakpointCallbacks({ workspacePath, sessionId });
      if (!listed.ok || listed.bindings.length === 0) return [];
      const lines = listed.bindings.map((item) => `${item.path}:${item.line}`).join(", ");
      return [`callback: this session is resumed at ${lines}`];
    }
  } catch (error) {
    return [
      `callback: not updated — ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return [];
}
