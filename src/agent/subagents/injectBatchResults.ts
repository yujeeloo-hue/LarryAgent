import type {
  AssistantMessage,
  Message,
  ToolMessage,
} from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { formatSubagentBatchResultText } from "./manager.js";
import type { SubagentBatchResult } from "./types.js";

/** Synthetic + model-callable tool name (registered builtin; auto-injected by runtime). */
export const SUBAGENT_BATCH_RESULT_TOOL = "subagent_batch_result";

export function injectSubagentBatchResults(input: {
  sessionMessages: Message[];
  batches: SubagentBatchResult[];
  createId: () => string;
}): void {
  if (input.batches.length === 0) return;
  const now = Date.now();

  for (const batch of input.batches) {
    const toolCallId = input.createId();
    const args = { batch_id: batch.batchId };
    const argumentsRaw = JSON.stringify(args);
    const text = formatSubagentBatchResultText(batch);

    // Synthetic assistant+tool_call pair for the parent model. DeepSeek
    // thinking mode requires `reasoning_content` on every tool-call assistant
    // message in subsequent requests — omit it and the next parent round 400s.
    const assistant: AssistantMessage = {
      id: input.createId(),
      role: "assistant",
      createdAt: now,
      toolCallId,
      parts: [
        {
          type: "reasoning",
          text: "",
        },
        {
          type: "tool_call",
          id: toolCallId,
          name: SUBAGENT_BATCH_RESULT_TOOL,
          status: "done",
          arguments: args,
          argumentsRaw,
        },
      ],
    };

    const tool: ToolMessage = {
      id: input.createId(),
      role: "tool",
      createdAt: now,
      toolCallId,
      parts: [
        {
          type: "tool_result",
          toolCallId,
          returnCode: ToolReturnCode.Success,
          content: [{ type: "text", text }],
          executionSummary: `subagent_batch_result delivered batch ${batch.batchId}: succeeded.`,
        },
      ],
    };

    input.sessionMessages.push(assistant, tool);
  }
}
