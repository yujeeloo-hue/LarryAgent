import type { JsonObject } from "../session/types.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type {
  ToolDefinition,
  ToolExecuteResult,
  ToolHandler,
} from "../tools/types.js";
import {
  unregisterToolsWhere,
  upsertTool,
} from "../tools/registry.js";
import {
  encodeMcpToolName,
  mcpToolNamePrefixForServer,
} from "./toolNames.js";
import type { McpDiscoveredTool } from "./types.js";

type McpToolMeta = {
  serverId: string;
  originalName: string;
  description: string;
  inputSchema: JsonObject;
};

/**
 * Register (or refresh) MCP tools for one server into the agent registry.
 * Default permission is Allow (0); per-tool overrides use the shared permission config.
 */
export function syncServerToolsToRegistry(
  serverId: string,
  tools: McpToolMeta[],
  callTool: (
    serverId: string,
    originalName: string,
    args: JsonObject,
    signal?: AbortSignal,
  ) => Promise<ToolExecuteResult>,
): McpDiscoveredTool[] {
  unregisterServerToolsFromRegistry(serverId);

  const usedNames = new Set<string>();
  const discovered: McpDiscoveredTool[] = [];

  for (const tool of tools) {
    let registryName = encodeMcpToolName(serverId, tool.originalName);
    if (usedNames.has(registryName)) {
      let n = 2;
      while (usedNames.has(`${registryName}_${n}`)) n += 1;
      registryName = `${registryName}_${n}`;
    }
    usedNames.add(registryName);

    const definition: ToolDefinition = {
      name: registryName,
      description:
        tool.description.trim() ||
        `MCP tool ${tool.originalName} (server ${serverId})`,
      parameters: normalizeInputSchema(tool.inputSchema),
      defaultPermissionLevel: 0,
    };

    const sid = serverId;
    const original = tool.originalName;
    const handler: ToolHandler = async (args, ctx) =>
      ctx.cocoMcpCall ? ctx.cocoMcpCall(sid, original, args, ctx.signal) : callTool(sid, original, args, ctx.signal);

    upsertTool(definition, handler);
    discovered.push({
      name: tool.originalName,
      description: definition.description,
      registryName,
      defaultPermissionLevel: 0,
      permissionLevel: 0,
      offered: false,
      callCount: 0,
    });
  }

  discovered.sort((a, b) => a.name.localeCompare(b.name));
  return discovered;
}

export function unregisterServerToolsFromRegistry(serverId: string): void {
  const prefix = mcpToolNamePrefixForServer(serverId);
  unregisterToolsWhere((name) => name.startsWith(prefix));
}

function normalizeInputSchema(schema: JsonObject): JsonObject {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const type = schema.type;
  if (type !== "object") {
    return {
      type: "object",
      properties:
        typeof schema.properties === "object" &&
        schema.properties !== null &&
        !Array.isArray(schema.properties)
          ? (schema.properties as JsonObject)
          : {},
    };
  }
  return schema;
}

/** Map MCP callTool result into our tool_result shape. */
export function mapMcpCallResult(result: unknown): ToolExecuteResult {
  if (!result || typeof result !== "object") {
    return {
      content: [{ type: "text", text: String(result ?? "") }],
      returnCode: ToolReturnCode.Success,
    };
  }

  const record = result as Record<string, unknown>;

  // Legacy compatibility shape
  if ("toolResult" in record && !("content" in record)) {
    const text =
      typeof record.toolResult === "string"
        ? record.toolResult
        : JSON.stringify(record.toolResult, null, 2);
    return {
      content: [{ type: "text", text }],
      returnCode: ToolReturnCode.Success,
    };
  }

  const isError = record.isError === true;
  const parts: ToolExecuteResult["content"] = [];
  const content = Array.isArray(record.content) ? record.content : [];

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image" && typeof part.data === "string") {
      const mime =
        typeof part.mimeType === "string" && part.mimeType.trim()
          ? part.mimeType.trim()
          : "image/png";
      parts.push({
        type: "attachment",
        kind: "image",
        uri: `data:${mime};base64,${part.data}`,
        mimeType: mime,
      });
      continue;
    }
    if (part.type === "resource" && part.resource && typeof part.resource === "object") {
      const resource = part.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        const uri =
          typeof resource.uri === "string" ? resource.uri : "resource";
        parts.push({
          type: "text",
          text: `[resource ${uri}]\n${resource.text}`,
        });
      } else {
        parts.push({
          type: "text",
          text: JSON.stringify(part, null, 2),
        });
      }
      continue;
    }
    if (part.type === "resource_link") {
      const name = typeof part.name === "string" ? part.name : "resource";
      const uri = typeof part.uri === "string" ? part.uri : "";
      parts.push({
        type: "text",
        text: uri ? `Resource link: ${name} (${uri})` : `Resource link: ${name}`,
      });
      continue;
    }
    if (part.type === "audio") {
      parts.push({ type: "text", text: "[audio content omitted]" });
      continue;
    }
    parts.push({ type: "text", text: JSON.stringify(part, null, 2) });
  }

  if (
    parts.length === 0 &&
    record.structuredContent &&
    typeof record.structuredContent === "object"
  ) {
    parts.push({
      type: "text",
      text: JSON.stringify(record.structuredContent, null, 2),
    });
  }

  if (parts.length === 0) {
    parts.push({ type: "text", text: isError ? "MCP tool error" : "" });
  }

  return {
    content: parts,
    returnCode: isError
      ? ToolReturnCode.GenericFailure
      : ToolReturnCode.Success,
  };
}
