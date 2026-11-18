import type { OpenAiToolDefinition } from "../llm/types.js";
import { listTools } from "../tools/registry.js";

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
