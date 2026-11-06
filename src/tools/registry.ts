import type {
  RegisteredTool,
  ToolDefinition,
  ToolExecutionSummarizer,
  ToolHandler,
} from "./types.js";

const tools = new Map<string, RegisteredTool>();

export type RegisterToolOptions = {
  summarizeExecution?: ToolExecutionSummarizer;
};

export function registerTool(
  definition: ToolDefinition,
  execute: ToolHandler,
  options?: RegisterToolOptions,
): void {
  if (tools.has(definition.name)) {
    throw new Error(`Tool already registered: ${definition.name}`);
  }
  tools.set(definition.name, {
    definition,
    execute,
    ...(options?.summarizeExecution
      ? { summarizeExecution: options.summarizeExecution }
      : {}),
  });
}

/**
 * Replace an existing registration, or add if missing.
 * Used when MCP tools refresh after reconnect.
 */
export function upsertTool(
  definition: ToolDefinition,
  execute: ToolHandler,
  options?: RegisterToolOptions,
): void {
  tools.set(definition.name, {
    definition,
    execute,
    ...(options?.summarizeExecution
      ? { summarizeExecution: options.summarizeExecution }
      : {}),
  });
}

export function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}

export function listTools(): RegisteredTool[] {
  return [...tools.values()];
}

export function unregisterTool(name: string): boolean {
  return tools.delete(name);
}

export function unregisterToolsWhere(
  predicate: (name: string) => boolean,
): number {
  let removed = 0;
  for (const name of [...tools.keys()]) {
    if (!predicate(name)) continue;
    tools.delete(name);
    removed += 1;
  }
  return removed;
}

