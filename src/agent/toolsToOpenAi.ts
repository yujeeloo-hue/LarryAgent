import { describeWithKnowledgeGuide } from "../knowledge/toolGuides.js";
import { knowledgeBase } from "../knowledge/store.js";
import type { OpenAiToolDefinition } from "../llm/types.js";
import { listTools } from "../tools/registry.js";

export function toolsToOpenAi(
  predicate?: (name: string) => boolean,
): OpenAiToolDefinition[] {
  const guides = knowledgeBase.isConfigured() ? knowledgeBase.guideMap() : null;
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
      const description = describeWithKnowledgeGuide(
        definition.description ?? "",
        guides?.get(definition.name),
      );
      if (description) {
        tool.function.description = description;
      }
      return tool;
    });
}
