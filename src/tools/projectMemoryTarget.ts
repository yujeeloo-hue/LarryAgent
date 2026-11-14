import { ToolReturnCode } from "../session/returnCodes.js";
import type { JsonObject } from "../session/types.js";
import { failureResult } from "./pathUtil.js";
import type { ToolExecuteContext, ToolExecuteResult } from "./types.js";

/**
 * Workspace root for the project-memory tools: the session's own, or (CoCo)
 * another in-scope project via `workspace_id`. The argument is deliberately
 * not in the shared schema so ordinary agents' tool definitions stay unchanged;
 * CoCo's AGENT.md documents it.
 */
export function projectMemoryWorkspace(args: JsonObject, context: ToolExecuteContext): string | ToolExecuteResult {
  const target = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  if (target) {
    if (!context.cocoProjectPath) return failureResult("workspace_id is only available to CoCo; omit it to use this session's workspace.", ToolReturnCode.InvalidArguments);
    try { return context.cocoProjectPath(target); }
    catch (error) { return failureResult(error instanceof Error ? error.message : String(error), ToolReturnCode.NotFound); }
  }
  const workspacePath = context.workspacePath?.trim() ?? "";
  return workspacePath || failureResult("No workspace path on this session; PROJECT.md is unavailable.", ToolReturnCode.NotFound);
}
