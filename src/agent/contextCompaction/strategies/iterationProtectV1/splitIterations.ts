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
  age: number;
  chronoIndex: number;
  userPrefix: Message[];
  messages: Message[];
  tokens: number;
};

export type ProtectWalkResult = {
  protectedIterations: ProtectIteration[];
  boundary?: ProtectIteration;
  protectedTokens: number;
  protectBudget: number;
  rawIterationCount: number;
};

export type ProtectEstimateOptions = {
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

export function splitGlobalProtectIterations(
  messages: Message[],
  options?: ProtectEstimateOptions,
): ProtectIteration[] {
  const turns = splitConversationTurns(messages);
  const chronoTurns = [...turns].sort((a, b) => b.age - a.age);

  const chronoIterations: Omit<ProtectIteration, "age">[] = [];
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
