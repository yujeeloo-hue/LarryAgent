import { mcpManager } from "../../mcp/manager.js";
import {
  formatMcpRuntimeSummary,
  parseMcpTransportArgs,
} from "../../mcp/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 1 (full-permissions gate). */
export const createMcpServerDefinition: ToolDefinition = {
  name: "create_mcp_server",
  description: "Create and connect an MCP server profile (stdio or HTTP).",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Display name for the MCP server.",
      },
      transport: {
        type: "string",
        enum: ["stdio", "http"],
        description:
          'Transport: "stdio" (needs command) or "http" (needs url). Do not mix field sets.',
      },
      command: {
        type: "string",
        description: 'stdio only: executable to spawn (e.g. "npx"). Ignored for http.',
      },
      args: {
        type: ["array", "string"],
        items: { type: "string" },
        description:
          'stdio only: argument list (string[]), or a space-separated string. Ignored for http.',
      },
      env: {
        type: "object",
        description: "stdio only: environment variables (string map). Ignored for http.",
        additionalProperties: { type: "string" },
      },
      cwd: {
        type: "string",
        description: "stdio only: optional working directory (absolute). Ignored for http.",
      },
      url: {
        type: "string",
        description: "http only: MCP endpoint URL. Ignored for stdio.",
      },
      headers: {
        type: "object",
        description: "http only: optional request headers (string map). Ignored for stdio.",
        additionalProperties: { type: "string" },
      },
      enabled: {
        type: "boolean",
        description: "Whether to connect immediately. Default true.",
      },
    },
    required: ["name", "transport"],
  },
  defaultPermissionLevel: 1,
};

export const createMcpServerHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return failureResult(
      'Invalid arguments: "name" (string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const existing = mcpManager.findServer(name);
  if (existing.runtime || existing.ambiguous) {
    return failureResult(
      `An MCP server named "${name}" already exists. Use update_mcp_server or pick a different name.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const parsed = parseMcpTransportArgs(args);
  if (!parsed.ok) {
    return failureResult(parsed.message, ToolReturnCode.InvalidArguments);
  }

  const enabled = args.enabled !== false;

  try {
    const runtime = await mcpManager.upsertServer({
      name,
      enabled,
      transport: parsed.transport,
    });
    try {
      await mcpManager.reloadFromDisk();
    } catch (err) {
      console.error("[mcp] reloadFromDisk failed after create", err);
    }
    return textResult(
      `Created MCP server.\n${formatMcpRuntimeSummary(runtime)}`,
      ToolReturnCode.Success,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create MCP server.";
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
