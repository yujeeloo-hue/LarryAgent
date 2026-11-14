import { mcpManager } from "../../mcp/manager.js";
import {
  formatMcpRuntimeSummary,
  parseMcpTransportArgs,
  resolveMcpServerRef,
} from "../../mcp/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { McpTransport } from "../../toolsConfig/types.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 1 (full-permissions gate). */
export const updateMcpServerDefinition: ToolDefinition = {
  name: "update_mcp_server",
  description: "Update an MCP server profile by id or name.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "MCP server id (preferred when known).",
      },
      name: {
        type: "string",
        description: "Server name lookup when id is omitted (or new name).",
      },
      new_name: {
        type: "string",
        description: "Optional new display name for the server.",
      },
      transport: {
        type: "string",
        enum: ["stdio", "http"],
        description:
          'When set, replace transport: "stdio" (needs command) or "http" (needs url). Do not mix field sets.',
      },
      command: {
        type: "string",
        description: "stdio only: executable to spawn. Ignored for http.",
      },
      args: {
        type: ["array", "string"],
        items: { type: "string" },
        description:
          "stdio only: argument list (string[]), or a space-separated string. Ignored for http.",
      },
      env: {
        type: "object",
        description: "stdio only: environment variables (string map). Ignored for http.",
        additionalProperties: { type: "string" },
      },
      cwd: {
        type: "string",
        description: "stdio only: optional working directory. Ignored for http.",
      },
      url: {
        type: "string",
        description: "http only: MCP endpoint URL. Ignored for stdio.",
      },
      headers: {
        type: "object",
        description: "http only: optional request headers. Ignored for stdio.",
        additionalProperties: { type: "string" },
      },
      enabled: {
        type: "boolean",
        description: "Optional enable/disable (connect or disconnect).",
      },
    },
    required: [],
  },
  defaultPermissionLevel: 1,
};

export const updateMcpServerHandler: ToolHandler = async (args, context) => {
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

  const current = resolved.runtime;
  const newName =
    typeof args.new_name === "string" && args.new_name.trim()
      ? args.new_name.trim()
      : // If looked up by id and `name` is provided without new_name, treat as rename.
        idArg && nameArg
        ? nameArg
        : current.name;

  let transport: McpTransport = current.transport;
  if (typeof args.transport === "string" && args.transport.trim()) {
    const parsed = parseMcpTransportArgs(args);
    if (!parsed.ok) {
      return failureResult(parsed.message, ToolReturnCode.InvalidArguments);
    }
    transport = parsed.transport;
  }

  const enabled =
    typeof args.enabled === "boolean" ? args.enabled : current.enabled;

  try {
    const runtime = await mcpManager.upsertServer({
      id: current.id,
      name: newName,
      enabled,
      transport,
    });
    try {
      await mcpManager.reloadFromDisk();
    } catch (err) {
      console.error("[mcp] reloadFromDisk failed after update", err);
    }
    return textResult(
      `Updated MCP server.\n${formatMcpRuntimeSummary(runtime)}`,
      ToolReturnCode.Success,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update MCP server.";
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
