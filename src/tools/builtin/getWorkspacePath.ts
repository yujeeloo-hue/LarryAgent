import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  textResult,
} from "../pathUtil.js";

/** Default level: 0 — returns the session workspace absolute path. */
export const getWorkspacePathDefinition: ToolDefinition = {
  name: "get_workspace_path",
  description: "Return the absolute path of the current workspace root.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

export const getWorkspacePathHandler: ToolHandler = async (_args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const raw = context.workspacePath.trim();
  if (!raw) {
    return failureResult(
      "No workspace path is set for this session.",
      ToolReturnCode.NotFound,
    );
  }

  return textResult(displayPath(raw), ToolReturnCode.Success);
};
