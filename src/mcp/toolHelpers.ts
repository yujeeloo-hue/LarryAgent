import type { JsonObject } from "../session/types.js";
import type { McpTransport } from "../toolsConfig/types.js";
import { mcpManager } from "./manager.js";
import type { McpServerRuntime } from "./types.js";

export type ParseTransportResult =
  | { ok: true; transport: McpTransport }
  | { ok: false; message: string };

/**
 * Parse MCP transport fields from agent tool arguments.
 * Expects `transport`: "stdio" | "http", plus type-specific fields.
 */
export function parseMcpTransportArgs(args: JsonObject): ParseTransportResult {
  const transportType =
    typeof args.transport === "string" ? args.transport.trim() : "";

  if (transportType === "stdio") {
    const command =
      typeof args.command === "string" ? args.command.trim() : "";
    if (!command) {
      return { ok: false, message: 'stdio transport requires "command".' };
    }
    const transport: McpTransport = { type: "stdio", command };

    if (Array.isArray(args.args)) {
      const parsedArgs = args.args
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim())
        .filter(Boolean);
      if (parsedArgs.length > 0) transport.args = parsedArgs;
    } else if (typeof args.args === "string" && args.args.trim()) {
      // Allow a single space-separated string for convenience.
      const parsedArgs = args.args
        .trim()
        .split(/\s+/)
        .map((a) => a.trim())
        .filter(Boolean);
      if (parsedArgs.length > 0) transport.args = parsedArgs;
    }

    const env = parseStringRecord(args.env);
    if (env) transport.env = env;

    if (typeof args.cwd === "string" && args.cwd.trim()) {
      transport.cwd = args.cwd.trim();
    }
    return { ok: true, transport };
  }

  if (transportType === "http") {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) {
      return { ok: false, message: 'http transport requires "url".' };
    }
    try {
      void new URL(url);
    } catch {
      return { ok: false, message: `Invalid URL: ${url}` };
    }
    const transport: McpTransport = { type: "http", url };
    const headers = parseStringRecord(args.headers);
    if (headers) transport.headers = headers;
    return { ok: true, transport };
  }

  return {
    ok: false,
    message: 'Invalid or missing "transport" (must be "stdio" or "http").',
  };
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const k = key.trim();
    if (!k || typeof raw !== "string") continue;
    out[k] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolveMcpServerRef(idOrName: string):
  | { ok: true; runtime: McpServerRuntime }
  | { ok: false; message: string; returnCodeHint: "not_found" | "ambiguous" | "invalid" } {
  const key = idOrName.trim();
  if (!key) {
    return {
      ok: false,
      message: 'Provide "id" or "name" of the MCP server.',
      returnCodeHint: "invalid",
    };
  }
  const found = mcpManager.findServer(key);
  if (found.ambiguous) {
    return {
      ok: false,
      message: `Multiple MCP servers match name "${key}". Use the server id instead.`,
      returnCodeHint: "ambiguous",
    };
  }
  if (!found.runtime) {
    return {
      ok: false,
      message: `MCP server not found: ${key}`,
      returnCodeHint: "not_found",
    };
  }
  return { ok: true, runtime: found.runtime };
}

export function formatMcpRuntimeSummary(runtime: McpServerRuntime): string {
  const transport =
    runtime.transport.type === "stdio"
      ? `stdio: ${runtime.transport.command}${(runtime.transport.args ?? []).length ? ` ${(runtime.transport.args ?? []).join(" ")}` : ""}`
      : `http: ${runtime.transport.url}`;
  const tools =
    runtime.status === "connected"
      ? runtime.tools.length === 0
        ? "tools: (none advertised)"
        : `tools (${runtime.tools.length}): ${runtime.tools.map((t) => t.name).join(", ")}`
      : `tools: (unavailable; status=${runtime.status})`;
  const err = runtime.errorMessage
    ? `\nerror: ${runtime.errorMessage}`
    : "";
  return [
    `id: ${runtime.id}`,
    `name: ${runtime.name}`,
    `enabled: ${runtime.enabled}`,
    `status: ${runtime.status}`,
    `transport: ${transport}`,
    tools,
  ].join("\n") + err;
}
