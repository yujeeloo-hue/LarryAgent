import { ToolReturnCode } from "../../session/returnCodes.js";
import { SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS } from "../../agent/subagents/constants.js";
import { formatSubagentBatchResultText } from "../../agent/subagents/manager.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

export const subagentBatchResultDefinition: ToolDefinition = {
  name: "subagent_batch_result",
  description:
    "Wait for or re-fetch JSON results for a subagent batch by batch_id.",
  parameters: {
    type: "object",
    properties: {
      batch_id: {
        type: "string",
        description: "Join group id passed to dispatch_subagent.",
      },
      timeout_ms: {
        type: "number",
        description: `Timeout in ms (default/min ${SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS}).`,
      },
    },
    required: ["batch_id"],
  },
  defaultPermissionLevel: 0,
};

export const subagentBatchResultHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.subagents) {
    return failureResult(
      "Subagent batch results are not available in this turn.",
      ToolReturnCode.GenericFailure,
    );
  }

  if (typeof args.batch_id !== "string" || !args.batch_id.trim()) {
    return failureResult(
      "batch_id must be a non-empty string.",
      ToolReturnCode.InvalidArguments,
    );
  }

  let timeoutMs: number | undefined;
  if (args.timeout_ms !== undefined) {
    if (
      typeof args.timeout_ms !== "number" ||
      !Number.isFinite(args.timeout_ms) ||
      args.timeout_ms <= 0
    ) {
      return failureResult(
        "timeout_ms must be a positive number when provided.",
        ToolReturnCode.InvalidArguments,
      );
    }
    timeoutMs = Math.floor(args.timeout_ms);
  }

  const outcome = await context.subagents.getBatchResult(
    args.batch_id.trim(),
    timeoutMs,
  );
  if (!outcome.ok) {
    return failureResult(outcome.message, outcome.returnCode);
  }

  return textResult(
    formatSubagentBatchResultText(outcome.result),
    ToolReturnCode.Success,
  );
};
