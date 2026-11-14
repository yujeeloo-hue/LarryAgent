import type { Message } from "../../../../session/types.js";
import {
  isCompactionMessage,
  messagesToOpenAi,
} from "../../messagesToOpenAi.js";
import {
  splitConversationTurns,
  splitTurnModelIterations,
} from "../../conversationTurns.js";
import { estimateTokensForMessages } from "../../../estimateTokens.js";
import {
  DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT,
  DEFAULT_ITERATION_PROTECT_TOKEN_RATIO,
} from "../../../../settings/types.js";

export type ProtectIteration = {
  /** 1 = newest globally. */
  age: number;
  /** Chronological index among all iterations (0 = oldest). */
  chronoIndex: number;
  /** Leading user messages of the Turn — attached only to the first model iteration of that Turn. */
  userPrefix: Message[];
  /** Assistant + following tool messages for this iteration. */
  messages: Message[];
  /** Estimated tokens (userPrefix once + iteration body). */
  tokens: number;
};

export type ProtectWalkResult = {
  /** Newest-first protected iterations (still raw). */
  protectedIterations: ProtectIteration[];
  /**
   * First iteration that failed protect (newest→oldest walk).
   * Undefined when every iteration stays protected.
   */
  boundary?: ProtectIteration;
  /** Cumulative tokens of protected iterations. */
  protectedTokens: number;
  protectBudget: number;
  rawIterationCount: number;
};

export type ProtectEstimateOptions = {
  /**
   * Same scope as the wire build. Without it native Responses output
   * (`model_response`) is not replayed in the estimate, so protect budgets
   * undercount what the model actually receives.
   */
  reasoningScope?: string;
};

function estimateIterationTokens(
  userPrefix: Message[],
  iterationMessages: Message[],
  options?: ProtectEstimateOptions,
): number {
  const wire = messagesToOpenAi(
    [...userPrefix, ...iterationMessages],
    options?.reasoningScope !== undefined ? { reasoningScope: options.reasoningScope } : undefined,
  );
  return estimateTokensForMessages(wire);
}

/**
 * Flatten conversation into global model iterations (age 1 = newest).
 * Turn user prefix tokens attach to the **first** (oldest) model iteration of that Turn only.
 */
export function splitGlobalProtectIterations(
  messages: Message[],
  options?: ProtectEstimateOptions,
): ProtectIteration[] {
  const turns = splitConversationTurns(messages);
  // Chronological turns (oldest first).
  const chronoTurns = [...turns].sort((a, b) => b.age - a.age);

  const chronoIterations: Omit<ProtectIteration, "age">[] = [];
  // Prompt-less sessions (CoCo automatic turns) can hold model iterations
  // before the first user message. They belong to no user Turn but still
  // must age into the summary like any other iteration.
  const firstTurnStart = chronoTurns[0]?.startIndex ?? messages.length;
  const leading = messages
    .slice(0, firstTurnStart)
    .filter((m) => !isCompactionMessage(m));
  const segments = [
    ...(leading.some((m) => m.role === "assistant") ? [leading] : []),
    ...chronoTurns.map((turn) => turn.messages.filter((m) => !isCompactionMessage(m))),
  ];
  for (const filtered of segments) {
    const { userPrefix, iterations } = splitTurnModelIterations(filtered);
    // Pending Turn: user has sent, but no assistant yet. Still emit a protect
    // iteration so buildModelMessages keeps the newest prompt on the wire
    // Without this the user prompt would be dropped.
    if (iterations.length === 0) {
      if (userPrefix.length > 0) {
        chronoIterations.push({
          chronoIndex: chronoIterations.length,
          userPrefix,
          messages: [],
          tokens: estimateIterationTokens(userPrefix, [], options),
        });
      }
      continue;
    }
    // iterations from splitTurnModelIterations are newest-first within the Turn.
    const oldestFirst = [...iterations].sort((a, b) => b.age - a.age);
    for (let i = 0; i < oldestFirst.length; i += 1) {
      const round = oldestFirst[i]!;
      const attachUser = i === 0 ? userPrefix : [];
      chronoIterations.push({
        chronoIndex: chronoIterations.length,
        userPrefix: attachUser,
        messages: round.messages,
        tokens: estimateIterationTokens(attachUser, round.messages, options),
      });
    }
  }

  const newestFirst = [...chronoIterations].reverse();
  return newestFirst.map((round, index) => ({
    ...round,
    age: index + 1,
  }));
}

/**
 * Walk newest → oldest; protect while among newest N and cum < limit * ratio.
 * First failing iteration is the compress boundary.
 */
export function walkProtectBoundary(
  messages: Message[],
  options: {
    contextLimitTokens: number;
    rawIterationCount?: number;
    tokenRatio?: number;
  } & ProtectEstimateOptions,
): ProtectWalkResult {
  const rawIterationCount = Math.max(
    1,
    Math.floor(
      options.rawIterationCount ?? DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT,
    ),
  );
  const tokenRatio =
    options.tokenRatio ?? DEFAULT_ITERATION_PROTECT_TOKEN_RATIO;
  const protectBudget = Math.floor(options.contextLimitTokens * tokenRatio);
  const iterations = splitGlobalProtectIterations(
    messages,
    options.reasoningScope !== undefined ? { reasoningScope: options.reasoningScope } : undefined,
  );

  const protectedIterations: ProtectIteration[] = [];
  let protectedTokens = 0;
  let boundary: ProtectIteration | undefined;

  for (const round of iterations) {
    const inNewestN = round.age <= rawIterationCount;
    const nextCum = protectedTokens + round.tokens;
    if (inNewestN && nextCum < protectBudget) {
      protectedIterations.push(round);
      protectedTokens = nextCum;
      continue;
    }
    boundary = round;
    break;
  }

  return {
    protectedIterations,
    ...(boundary ? { boundary } : {}),
    protectedTokens,
    protectBudget,
    rawIterationCount,
  };
}

/** All messages belonging to a protect round (user prefix + round body). */
export function iterationAllMessages(round: ProtectIteration): Message[] {
  return [...round.userPrefix, ...round.messages];
}

export function lastMessageId(round: ProtectIteration): string | undefined {
  const all = iterationAllMessages(round);
  return all[all.length - 1]?.id;
}

export function firstMessageId(round: ProtectIteration): string | undefined {
  const all = iterationAllMessages(round);
  return all[0]?.id;
}
