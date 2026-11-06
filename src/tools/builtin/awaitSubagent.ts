import { ToolReturnCode } from "../../session/returnCodes.js";
import { SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS } from "../../agent/subagents/constants.js";
import { parseSubagentResultPayload } from "../../agent/subagents/summary.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

function parseIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) return null;
    ids.push(item.trim());
  }
  return ids;
}

export const awaitSubagentDefinition: ToolDefinition = {
  name: "await_subagent",
  description:
    "Wait for specific subagents by id and return their JSON results.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Subagent ids from dispatch_subagent (≥1).",
      },
      timeout_ms: {
        type: "number",
        description: `Timeout in ms (default/min ${SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS}).`,
      },
    },
    required: ["ids"],
  },
  defaultPermissionLevel: 0,
};

export const awaitSubagentHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.subagents) {
    return failureResult(
      "Subagent await is not available in this turn.",
      ToolReturnCode.GenericFailure,
    );
  }

  const ids = parseIds(args.ids);
  if (!ids) {
    return failureResult(
      "ids must be a non-empty array of strings.",
      ToolReturnCode.InvalidArguments,
    );
  }

  let timeoutMs = SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS;
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
    // Floor to default so short model-chosen budgets (e.g. 120s) cannot
    // abort long-running explore workers early.
    timeoutMs = Math.max(
      Math.floor(args.timeout_ms),
      SUBAGENT_AWAIT_DEFAULT_TIMEOUT_MS,
    );
  }

  const entries = await context.subagents.awaitRuns(ids, timeoutMs);
  const payload = {
    entries: entries.map((entry) => {
      const fields = entry.summary
        ? parseSubagentResultPayload(entry.summary)
        : null;
      return {
        id: entry.id,
        name: entry.name,
        priority: entry.priority,
        status: entry.status,
        ...(entry.errorMessage ? { error: entry.errorMessage } : {}),
        ...(fields
          ? {
              result: fields.result,
              attachment: fields.attachment,
              table: fields.table,
            }
          : {}),
      };
    }),
  };

  return textResult(JSON.stringify(payload), ToolReturnCode.Success);
};
