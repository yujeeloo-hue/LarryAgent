import { isAbsolute, resolve } from "node:path";

import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  ToolDefinition,
  ToolExecuteContext,
  ToolExecuteResult,
  ToolHandler,
} from "../types.js";
import { displayPath, failureResult, textResult } from "../pathUtil.js";
import { resolveWorkspaceManager } from "../workspaceManagerPort.js";

const PORT_MISSING =
  "Workspace renaming is unavailable in this host (no workspace manager). " +
  "It is available in the desktop app and in headless agentd.";

export const renameWorkspaceDefinition: ToolDefinition = {
  name: "rename_workspace",
  description:
    "Rename a registered workspace on this device, including headless Linux agentd. " +
    "Pass the new display name and either workspace_id or workspace_path; omit both to rename the " +
    "current session's workspace. The directory path and sessions are unchanged, only the display " +
    "name changes. Use get_workspace_path to inspect the current workspace, and the id returned by " +
    "create_workspace to rename a newly created workspace. Do not pass workspace_id and " +
    "workspace_path together. Confirm the intended workspace when it is not explicit.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "New workspace display name.",
      },
      workspace_id: {
        type: "string",
        description:
          "Id of the workspace to rename. Defaults to the current session's workspace.",
      },
      workspace_path: {
        type: "string",
        description:
          "Absolute directory path of the workspace to rename, when the id is unknown.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

export const renameWorkspaceHandler: ToolHandler = async (
  args,
  context: ToolExecuteContext,
): Promise<ToolExecuteResult> => {
  const port = resolveWorkspaceManager(context);
  if (!port) return failureResult(PORT_MISSING);

  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return failureResult("name is required", ToolReturnCode.InvalidArguments);
  }

  const rawId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  const rawPath = typeof args.workspace_path === "string" ? args.workspace_path.trim() : "";
  if (rawId && rawPath) {
    return failureResult(
      "workspace_id and workspace_path are mutually exclusive",
      ToolReturnCode.InvalidArguments,
    );
  }
  if (rawPath && !isAbsolute(rawPath)) {
    return failureResult(
      "workspace_path must be an absolute directory path on this device",
      ToolReturnCode.InvalidArguments,
    );
  }

  const id = rawId || (!rawPath ? context.workspaceId || "" : "");
  if (!id && !rawPath) {
    return failureResult(
      "workspace_id or workspace_path is required when the session has no workspace",
      ToolReturnCode.InvalidArguments,
    );
  }
  if (rawPath) {
    try {
      context.assertPath?.(resolve(rawPath));
    } catch (error) {
      return failureResult(
        error instanceof Error ? error.message : String(error),
        ToolReturnCode.PermissionDenied,
      );
    }
  }

  try {
    const workspace = await port.rename({
      ...(id ? { id } : {}),
      ...(rawPath ? { path: resolve(rawPath) } : {}),
      name,
    });
    return textResult(
      `workspace renamed: ${workspace.name}${workspace.previousName ? ` (was ${workspace.previousName})` : ""} ` +
        `(id ${workspace.id}) at ${displayPath(workspace.path)}\n` +
        `current session workspace unchanged: ${displayPath(context.workspacePath)}`,
      ToolReturnCode.Success,
    );
  } catch (error) {
    return failureResult(
      error instanceof Error ? error.message : String(error),
    );
  }
};
