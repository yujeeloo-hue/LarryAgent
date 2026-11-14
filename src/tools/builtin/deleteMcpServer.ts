import { mcpManager } from "../../mcp/manager.js";
import { resolveMcpServerRef } from "../../mcp/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 1 (full-permissions gate). */
export const deleteMcpServerDefinition: ToolDefinition = {
  name: "delete_mcp_server",
  description: "Delete an MCP server profile by id or name.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "MCP server id (preferred when known).",
      },
      name: {
        type: "string",
        description: "MCP server display name when id is unknown.",
      },
    },
    required: [],
  },
  defaultPermissionLevel: 1,
};

export const deleteMcpServerHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const idArg = typeof args.id === "string" ? args.id.trim() : "";
  const nameArg = typeof args.name === "string" ? args.name.trim() : "";
  const ref = idArg || nameArg;
  if (!ref) {
    return failureResult(
      'Invalid arguments: provide "id" or "name" to identify the MCP server.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const resolved = resolveMcpServerRef(ref);
  if (!resolved.ok) {
    const code =
      resolved.returnCodeHint === "not_found"
        ? ToolReturnCode.NotFound
        : ToolReturnCode.InvalidArguments;
    return failureResult(resolved.message, code);
  }

  const { id, name } = resolved.runtime;
  try {
    await mcpManager.removeServer(id);
    try {
      await mcpManager.reloadFromDisk();
    } catch (err) {
      console.error("[mcp] reloadFromDisk failed after delete", err);
    }
    return textResult(
      `Deleted MCP server "${name}" (${id}).`,
      ToolReturnCode.Success,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to delete MCP server.";
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
