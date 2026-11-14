import type { OpenAiToolDefinition } from "../llm/types.js";
import { listTools } from "../tools/registry.js";

/**
 * Convert registered tools to OpenAI Chat Completions tools.
 * Default `strict: false` (schema is advisory; runtime still validates).
 */
export function toolsToOpenAi(
  predicate?: (name: string) => boolean,
): OpenAiToolDefinition[] {
  return listTools()
    .filter(({ definition }) =>
      predicate ? predicate(definition.name) : true,
    )
    .map(({ definition }) => {
      const tool: OpenAiToolDefinition = {
        type: "function",
        function: {
          name: definition.name,
          parameters: definition.parameters,
          strict: false,
        },
      };
      if (definition.description) {
        tool.function.description = definition.description;
      }
      return tool;
    });
}
