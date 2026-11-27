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
  "Workspace creation is unavailable in this host (no workspace manager). " +
  "It is available in the desktop app and in headless agentd.";

export const createWorkspaceDefinition: ToolDefinition = {
  name: "create_workspace",
  description:
    "Create and register a new agent workspace on this device, including headless Linux agentd. " +
    "Pass an absolute directory path; the directory is created if missing. Reusing a path that is " +
    "already registered returns that workspace instead of duplicating it. The new workspace becomes " +
    "the active workspace for subsequent sessions, but the current turn stays in its original workspace. " +
    "This only creates an empty directory and registers it — no project templates, git init, or dependency " +
    "install; use exec_command for those. Use get_workspace_path to inspect the current workspace. " +
    "Confirm the absolute path with the user when it is not explicit.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Workspace display name.",
      },
      path: {
        type: "string",
        description: "Absolute directory path for the new workspace on this device.",
      },
    },
    required: ["name", "path"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

export const createWorkspaceHandler: ToolHandler = async (
  args,
  context: ToolExecuteContext,
): Promise<ToolExecuteResult> => {
  const port = resolveWorkspaceManager(context);
  if (!port) return failureResult(PORT_MISSING);

  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return failureResult("name is required", ToolReturnCode.InvalidArguments);
  }
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return failureResult("path is required", ToolReturnCode.InvalidArguments);
  }
  if (!isAbsolute(rawPath)) {
    return failureResult(
      "path must be an absolute directory path on this device",
      ToolReturnCode.InvalidArguments,
    );
  }
  const path = resolve(rawPath);
  try {
    context.assertPath?.(path);
  } catch (error) {
    return failureResult(
      error instanceof Error ? error.message : String(error),
      ToolReturnCode.PermissionDenied,
    );
  }

  try {
    const workspace = await port.create({ name, path });
    const verb = workspace.existing ? "reused" : "created";
    return textResult(
      `workspace ${verb}: ${workspace.name} (id ${workspace.id}) at ${displayPath(workspace.path)}\n` +
        `active workspace: ${workspace.id}\n` +
        `current session workspace unchanged: ${displayPath(context.workspacePath)}`,
      ToolReturnCode.Success,
    );
  } catch (error) {
    return failureResult(
      error instanceof Error ? error.message : String(error),
    );
  }
};
