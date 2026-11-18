import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { DebugToolBreakpointOp } from "../debugControlPort.js";
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
    "Only debug_run action=start honours them.",
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

  const port = debugPort(context);
  if (isToolResult(port)) return port;

  const target = resolveDebugWorkspace(args, context);
  if (isToolResult(target)) return target;

  let op: DebugToolBreakpointOp;
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
  const header =
    action === "list"
      ? "Workspace breakpoints"
      : `Breakpoint ${action} applied`;
  return textResult(
    `${header} (${target.path})\n${formatBreakpoints(result.breakpoints)}`,
    ToolReturnCode.Success,
  );
};
