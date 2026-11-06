import type {
  AssistantMessage,
  TextPart,
} from "../../../session/types.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";
import { titledEmptySchema } from "./schemaHelpers.js";

export const NodeActionFillEmptyAssistantSchema = titledEmptySchema(
  "Fill empty assistant",
  "If the last assistant reply has no visible text, fill it from the round (e.g. reasoning-only) before ending the turn.",
  `Guarantees the user always sees a visible reply. Reads this round's assistant message (nodeContext first, then the turn-level lastAssistantRound slot written by Call model) and, when it carries no visible text part — a reasoning-only or tool-only reply — calls host.finalizeEmptyAssistant to fill the part from the buffered reasoning text.

Always sets turnContext.finalizedEmptyAssistant so end nodes can branch on whether the fill already happened.`,
  "End-node filler: when the model round produced no visible text (a reasoning-only or tool-only reply), fill the assistant reply from the buffered reasoning so the user always sees an answer. No params.",
);

export class NodeActionFillEmptyAssistant extends NodeActionStubBase {
  readonly type = "NodeActionFillEmptyAssistant";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        turnContextPatch: { finalizedEmptyAssistant: true },
      };
    }

    // Round-scoped first (nodeContext); the typed turn-level slot written by
    // Call model covers the bare-reply → end cross-visit read.
    const round = args.turnContext.lastAssistantRound as {
      assistant?: AssistantMessage;
      textPart?: TextPart | null;
      reasoningBuf?: string;
    } | undefined;
    const assistant = (args.nodeContext.assistant ??
      round?.assistant) as AssistantMessage | undefined;
    if (!assistant) {
      return {
        status: "continue",
        turnContextPatch: { finalizedEmptyAssistant: true },
      };
    }

    const textPart = (args.nodeContext.textPart ??
      round?.textPart) as TextPart | undefined;
    const reasoningBuf =
      typeof args.nodeContext.reasoningBuf === "string"
        ? args.nodeContext.reasoningBuf
        : typeof round?.reasoningBuf === "string"
          ? round.reasoningBuf
          : "";

    host.finalizeEmptyAssistant({
      assistant,
      ...(textPart ? { textPart } : {}),
      reasoningBuf,
    });

    return {
      status: "continue",
      turnContextPatch: { finalizedEmptyAssistant: true },
    };
  }
}
