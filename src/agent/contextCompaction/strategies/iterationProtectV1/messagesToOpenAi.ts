import type { OpenAiChatMessage } from "../../../../llm/types.js";
import type {
  ContextCompactionPart,
  Message,
} from "../../../../session/types.js";
import {
  splitConversationTurns,
  splitTurnModelIterations,
} from "../../conversationTurns.js";
import {
  findLatestModelWindowFloor,
  isClearMessage,
  isCompactionMessage,
  isNewTaskMessage,
  messagesAfterModelWindowFloor,
  messagesToOpenAi,
} from "../../messagesToOpenAi.js";
import { activePlanPin, formatPlanPin } from "../../planPin.js";
import type { CompactionBuildConfig } from "../../types.js";
import {
  iterationAllMessages,
  splitGlobalProtectIterations,
  type ProtectIteration,
} from "./splitIterations.js";

export function getCompactionPart(
  message: Message,
): ContextCompactionPart | null {
  if (message.role !== "system") return null;
  for (const part of message.parts) {
    if (part.type === "context_compaction") return part;
  }
  return null;
}

export function findLatestIterationProtectCompaction(
  messages: Message[],
): { markerIndex: number; part: ContextCompactionPart } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const part = getCompactionPart(messages[i]!);
    if (!part) continue;
    if (part.summary.trim().length > 0) {
      return { markerIndex: i, part };
    }
    if (part.coveredThroughMessageId || part.coveredThroughUserMessageId) {
      return { markerIndex: i, part };
    }
  }
  return null;
}

function messageIndexById(messages: Message[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    map.set(messages[i]!.id, i);
  }
  return map;
}

export function selectIterationsToSummarize(
  allNewestFirst: ProtectIteration[],
  boundary: ProtectIteration,
  coveredThroughMessageId: string | undefined,
  messages: Message[],
): ProtectIteration[] {
  const idIndex = messageIndexById(messages);
  const coveredIndex =
    coveredThroughMessageId !== undefined
      ? idIndex.get(coveredThroughMessageId)
      : undefined;

  const candidates = allNewestFirst.filter((r) => r.age >= boundary.age);
  const oldestFirst = [...candidates].sort(
    (a, b) => a.chronoIndex - b.chronoIndex,
  );

  if (coveredIndex === undefined) {
    return oldestFirst;
  }

  return oldestFirst.filter((round) => {
    const all = iterationAllMessages(round);
    const last = all[all.length - 1];
    if (!last) return false;
    const idx = idIndex.get(last.id);
    if (idx === undefined) return true;
    return idx > coveredIndex;
  });
}

export function liveTurnUserPrefixes(
  withoutMarkers: Message[],
  live: Message[],
): Message[] {
  const liveIds = new Set(live.map((m) => m.id));
  if (liveIds.size === 0) {
    const users = withoutMarkers.filter((m) => m.role === "user");
    const newest = users[users.length - 1];
    return newest ? [newest] : [];
  }

  const chronoTurns = [...splitConversationTurns(withoutMarkers)].sort(
    (a, b) => a.startIndex - b.startIndex,
  );
  const kept: Message[] = [];
  const keptIds = new Set<string>();
  for (const turn of chronoTurns) {
    const intersectsLive = turn.messages.some((m) => liveIds.has(m.id));
    if (!intersectsLive) continue;
    const { userPrefix } = splitTurnModelIterations(
      turn.messages.filter((m) => !isCompactionMessage(m)),
    );
    for (const msg of userPrefix) {
      if (msg.role !== "user") continue;
      if (liveIds.has(msg.id) || keptIds.has(msg.id)) continue;
      kept.push(msg);
      keptIds.add(msg.id);
    }
  }
  return kept;
}

export function buildModelMessages(
  messages: Message[],
  config?: CompactionBuildConfig,
): OpenAiChatMessage[] {
  if (findLatestModelWindowFloor(messages) >= 0) {
    return buildModelMessages(messagesAfterModelWindowFloor(messages), config);
  }
  const latest = findLatestIterationProtectCompaction(messages);
  const withoutMarkers = messages.filter(
    (m) => !isCompactionMessage(m) && !isClearMessage(m) && !isNewTaskMessage(m),
  );
  const wireOptions = {
    ...(config?.imageUrls === true ? { imageUrls: true } : {}),
    ...(config?.toolRoleImages === true ? { toolRoleImages: true } : {}),
    ...(config?.reasoningScope !== undefined ? { reasoningScope: config.reasoningScope } : {}),
  };

  if (!latest || !latest.part.summary.trim()) {
    return messagesToOpenAi(withoutMarkers, wireOptions);
  }

  const coveredId = coverageCursorId(latest.part);
  const coveredIdx = coveredId
    ? withoutMarkers.findIndex((m) => m.id === coveredId)
    : -1;

  const planPin = activePlanPin(
    coveredIdx >= 0
      ? withoutMarkers.slice(0, coveredIdx + 1)
      : messages.slice(0, latest.markerIndex),
    config?.activePlan,
    withoutMarkers,
  );

  const out: OpenAiChatMessage[] = [];
  out.push({
    role: "system",
    content: `Previous conversation summary:\n${latest.part.summary.trim()}${
      latest.part.demoVerbatim ? `\n\n${latest.part.demoVerbatim}` : ""
    }${planPin ? `\n\n${formatPlanPin(planPin)}` : ""}`,
  });

  const firstUserIdx = withoutMarkers.findIndex((m) => m.role === "user");
  const prefixStart = coveredIdx >= 0 ? coveredIdx + 1 : 0;
  if (firstUserIdx > prefixStart) {
    out.push(
      ...messagesToOpenAi(withoutMarkers.slice(prefixStart, firstUserIdx), wireOptions),
    );
  }

  let live: Message[];
  if (coveredIdx >= 0) {
    live = withoutMarkers.slice(coveredIdx + 1);
  } else {
    live = messages
      .slice(latest.markerIndex + 1)
      .filter((m) => !isCompactionMessage(m));
    if (live.length === 0) {
      live = withoutMarkers;
    }
  }

  if (firstUserIdx > 0) {
    const prefixIds = new Set(
      withoutMarkers.slice(0, firstUserIdx).map((m) => m.id),
    );
    live = live.filter((m) => !prefixIds.has(m.id));
  }

  out.push(
    ...messagesToOpenAi(liveTurnUserPrefixes(withoutMarkers, live), wireOptions),
  );
  out.push(...messagesToOpenAi(live, wireOptions));
  return out;
}

export function coverageCursorId(
  part: ContextCompactionPart,
): string | undefined {
  const id =
    part.coveredThroughMessageId?.trim() ||
    part.coveredThroughUserMessageId?.trim() ||
    part.toMessageId?.trim() ||
    "";
  return id || undefined;
}

export function listAllIterationsNewestFirst(messages: Message[]): ProtectIteration[] {
  return splitGlobalProtectIterations(messages);
}
