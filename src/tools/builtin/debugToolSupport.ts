import type {
  JsonObject,
  ToolExecuteContext,
  ToolExecuteResult,
} from "../types.js";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  failureResult,
  resolveToolPath,
  workspaceRootAbsolute,
} from "../pathUtil.js";
import type {
  DebugControlPort,
  DebugToolBreakpoint,
  DebugToolSnapshot,
} from "../debugControlPort.js";
import { resolveDebugControl } from "../debugControlPort.js";

export const DEBUG_PORT_MISSING =
  "Debug control is unavailable in this host (no debug port). " +
  "Start debugging from the Dev Mode Debug button instead, or run the app with the desktop UI.";

export function resolveDebugWorkspace(
  args: JsonObject,
  context: ToolExecuteContext,
): { path: string } | ToolExecuteResult {
  const byId =
    typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  const byPath =
    typeof args.workspace_path === "string" ? args.workspace_path.trim() : "";
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

export function resolveBreakpointFile(
  raw: string,
  workspacePath: string,
  context: ToolExecuteContext,
): { path: string } | ToolExecuteResult {
  const root = workspaceRootAbsolute(workspacePath);
  const candidate =
    raw.startsWith("file:") || isAbsolute(raw) ? raw : resolvePath(root, raw);
  const resolved = resolveToolPath(candidate, {
    workspacePath: root,
    allowOutsideWorkspace: context.fullPermissionsEnabled === true,
  });
  if (!resolved.ok) return failureResult(resolved.reason, resolved.returnCode);
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

export function debugPort(
  context: ToolExecuteContext,
): DebugControlPort | ToolExecuteResult {
  const port = resolveDebugControl(context);
  if (!port) return failureResult(DEBUG_PORT_MISSING, ToolReturnCode.GenericFailure);
  return port;
}

export function isToolResult(value: unknown): value is ToolExecuteResult {
  return Boolean(value) && typeof value === "object" && "returnCode" in (value as object);
}

export function formatLocation(snapshot: DebugToolSnapshot): string {
  const frame = snapshot.stack[0];
  if (!frame) return "location unknown (no stack frame)";
  const file = frame.file ?? "(no source)";
  return `#0 ${frame.name}  ${file}:${frame.line}`;
}

export function formatStack(snapshot: DebugToolSnapshot, limit = 20): string[] {
  if (snapshot.stack.length === 0) return ["stack: (empty)"];
  const lines = [`stack: ${snapshot.stack.length} frame(s)`];
  for (const [index, frame] of snapshot.stack.slice(0, limit).entries()) {
    const marker = index === 0 ? "*" : " ";
    const selected = snapshot.selectedFrameId === frame.id ? " ←selected" : "";
    lines.push(
      `${marker} #${index} ${frame.name}  ${frame.file ?? "(no source)"}:${frame.line}${selected}`,
    );
  }
  if (snapshot.stack.length > limit) {
    lines.push(`… ${snapshot.stack.length - limit} more frame(s)`);
  }
  return lines;
}

export function formatLocals(
  snapshot: DebugToolSnapshot,
  limit = 40,
): string[] {
  if (snapshot.locals.length === 0) return ["locals: (none reported for this frame)"];
  const lines = [`locals: ${snapshot.locals.length}`];
  for (const variable of snapshot.locals.slice(0, limit)) {
    const type = variable.type ? ` (${variable.type})` : "";
    const ref = variable.variablesReference > 0 ? ` [ref ${variable.variablesReference}]` : "";
    lines.push(`  ${variable.name}${type} = ${variable.value}${ref}`);
  }
  if (snapshot.locals.length > limit) {
    lines.push(`… ${snapshot.locals.length - limit} more`);
  }
  return lines;
}

export function formatTargets(snapshot: DebugToolSnapshot): string[] {
  if (snapshot.status === "idle") return ["session: idle (debugger not attached)"];
  const lines = [
    `session: ${snapshot.status}${snapshot.recipe ? ` · ${snapshot.recipe}` : ""}` +
      `${snapshot.selectedTargetId ? ` · target ${snapshot.selectedTargetId}` : ""}`,
  ];
  if (snapshot.threads.length > 0) {
    lines.push(
      `threads: ${snapshot.threads
        .map((thread) =>
          thread.id === snapshot.selectedThreadId
            ? `${thread.id}*(${thread.name})`
            : `${thread.id}(${thread.name})`,
        )
        .join(", ")}`,
    );
  }
  if (snapshot.targets.length > 0) {
    lines.push(
      `targets: ${snapshot.targets
        .map((target) =>
          `${target.id}${target.id === snapshot.selectedTargetId ? "*" : ""}(${target.label} · ${target.status})`,
        )
        .join(", ")}`,
    );
  }
  return lines;
}

export function formatConsole(
  snapshot: DebugToolSnapshot,
  limit = 8,
): string[] {
  if (snapshot.console.length === 0) return [];
  const marker = { send: ">", receive: "·", error: "!" } as const;
  const rows = snapshot.console.slice(-limit);
  return [
    `debug console (last ${rows.length}):`,
    ...rows.map((row) => `  ${marker[row.direction]} ${row.text}`),
  ];
}

export function describeSnapshot(
  snapshot: DebugToolSnapshot,
  options: { stack?: boolean; locals?: boolean; console?: boolean } = {},
): string {
  const lines = [`status: ${snapshot.status}`];
  if (snapshot.progressText) lines.push(`progress: ${snapshot.progressText}`);
  if (snapshot.error) lines.push(`error: ${snapshot.error}`);
  if (snapshot.recipe) lines.push(`recipe: ${snapshot.recipe}`);
  if (snapshot.error === undefined && snapshot.status !== "idle") {
    lines.push(...formatTargets(snapshot));
  }
  if (snapshot.status === "stopped") {
    const reason = snapshot.stopped?.reason;
    const detail = snapshot.stopped?.description ?? snapshot.stopped?.text;
    lines.push(
      `stopped: ${reason ?? "unknown reason"}${detail ? ` — ${detail}` : ""}`,
    );
    lines.push(`location: ${formatLocation(snapshot)}`);
    if (options.stack !== false) lines.push(...formatStack(snapshot));
    if (options.locals !== false) lines.push(...formatLocals(snapshot));
  }
  if (options.console !== false) lines.push(...formatConsole(snapshot));
  return lines.join("\n");
}

export function formatBreakpoints(list: DebugToolBreakpoint[]): string {
  if (list.length === 0) return "breakpoints: (none)";
  const lines = [`breakpoints: ${list.length}`];
  for (const item of list) {
    const state = item.enabled ? "enabled" : "disabled";
    const condition = item.condition ? ` if ${item.condition}` : "";
    lines.push(`  ${item.path}:${item.line} · ${state}${condition}`);
  }
  return lines.join("\n");
}
