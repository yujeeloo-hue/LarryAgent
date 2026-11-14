import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, textResult } from "../pathUtil.js";
import {
  runTurnHandoffTool,
  type TurnHandoffToolInput,
} from "../turnHandoffTool.js";

export const turnHandoffDefinition: ToolDefinition = {
  name: "turn_handoff",
  description:
    "Queue this session's next turn to run automatically on a chosen FSM graph after the current turn completes (self-harness chaining). queue { graphId, prompt }: the graph must exist and be enabled (see fsm_graph list / create + user enable); you author the user prompt the next turn starts with — it runs in this same session with full conversation context and inherits this turn's full-permissions state. Queueing again replaces the pending entry (last wins); cancel clears it. The follow-up turn starts only when this turn completes normally — an errored or cancelled turn drops the queue (with a visible system note), any real user message clears it too, and chained handoffs are depth-capped. Disabled by default in every mode: the user must enable Turn Handoff in the composer's Self Learning section, otherwise every call fails with handoff_disabled.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["queue", "cancel"],
        description:
          "queue schedules the follow-up turn (graphId + prompt required); cancel clears a previously queued handoff (graphId/prompt ignored).",
      },
      graphId: {
        type: "string",
        description:
          "Library graph id to run the next turn on (queue only; omit on cancel). Must be enabled — LLM-authored graphs are disabled until the user enables them in the Graphs editor.",
      },
      prompt: {
        type: "string",
        description:
          "The user prompt the queued turn starts with (queue only; omit on cancel). Author it self-sufficiently: it is the next turn's only new input beyond this session's conversation context.",
      },
      note: {
        type: "string",
        description:
          "Optional human-readable reason for the handoff, shown in the session progress line while queued.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

export const turnHandoffHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.turnHandoff || !context.sessionId) {
    return textResult(
      JSON.stringify({
        ok: false,
        error:
          "turn_handoff is unavailable: handoff port is not wired in this host",
      }),
      ToolReturnCode.GenericFailure,
    );
  }

  const result = await runTurnHandoffTool(
    args as TurnHandoffToolInput,
    context.sessionId,
    context.turnHandoff,
  );
  return textResult(
    JSON.stringify(result, null, 2),
    result.ok ? ToolReturnCode.Success : ToolReturnCode.GenericFailure,
  );
};
