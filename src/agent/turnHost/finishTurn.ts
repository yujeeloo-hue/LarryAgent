import { randomUUID } from "node:crypto";
import type { StreamEvent } from "../../llm/streamEvents.js";
import {
  agentLogError,
  agentLogInfo,
  agentLogWarn,
} from "../../logging/agentLog.js";
import type { Session } from "../../session/types.js";
import { getCompactionStrategy } from "../contextCompaction/registry.js";
import type { RunAgentTurnResult } from "../types.js";
import { emit } from "./emit.js";
import { touch } from "./touch.js";

export type FinishTurnBuildConfig = {
  contextLimitTokens: number;
  hotTurnCount?: number;
  warmTurnCount?: number;
  hotRawIterationCount?: number;
  iterationProtectRawIterationCount?: number;
  iterationProtectTokenRatio?: number;
};

export async function finishTurn(input: {
  session: Session;
  status: RunAgentTurnResult["status"];
  progressText: string;
  onEvent?: (event: StreamEvent) => void;
  doneReason: "completed" | "cancelled" | "paused" | "error";
  modelIterations: number;
  turnStartedAt: number;
  hooks?: import("../../hooks/types.js").HookRunner;
  strategy: ReturnType<typeof getCompactionStrategy>;
  buildConfig: FinishTurnBuildConfig;
}): Promise<RunAgentTurnResult> {
  const {
    session,
    status,
    progressText,
    onEvent,
    doneReason,
    modelIterations,
    turnStartedAt,
    hooks,
    strategy,
    buildConfig,
  } = input;

  session.status = status;
  session.progressText = progressText;
  touch(session);

  // Persist turn errors in the transcript so the UI can show them inline.
  if (doneReason === "error") {
    const trimmed = progressText.trim();
    if (trimmed) {
      const last = session.messages[session.messages.length - 1];
      const lastText =
        last?.role === "system" &&
        last.parts.length === 1 &&
        last.parts[0]?.type === "text"
          ? last.parts[0].text.trim()
          : "";
      if (lastText !== trimmed) {
        session.messages.push({
          id: randomUUID(),
          role: "system",
          createdAt: Date.now(),
          parts: [{ type: "text", text: trimmed, error: true }],
        });
        touch(session);
      }
    }
  }

  strategy.refreshSessionCompactionState(session, buildConfig);
  const snapshot = session.contextBuckets;
  if (snapshot) {
    agentLogInfo("context.buckets", {
      sessionId: session.id,
      strategy: strategy.id,
      hot: snapshot.hot,
      warm: snapshot.warm,
      cold: snapshot.cold,
      hotTurnCount: snapshot.hotTurnCount,
      warmTurnCount: snapshot.warmTurnCount,
    });
  }

  emit(onEvent, { type: "status", status });
  emit(onEvent, { type: "done", reason: doneReason });

  if (hooks) {
    const stopPayload = {
      sessionId: session.id,
      workspacePath: session.workspacePath,
      status,
      done_reason: doneReason,
      model_iterations: modelIterations,
    };
    try {
      await hooks.run("stop", stopPayload);
      await hooks.run("turnEnd", stopPayload);
    } catch {
      // Observational; never fail the turn on stop/turnEnd errors
    }
  }

  const fields = {
    sessionId: session.id,
    status,
    doneReason,
    modelIterations,
    durationMs: Date.now() - turnStartedAt,
    ...(progressText ? { progressText } : {}),
  };
  if (doneReason === "error") {
    agentLogError("turn.end", fields);
  } else if (doneReason === "cancelled") {
    agentLogWarn("turn.end", fields);
  } else {
    agentLogInfo("turn.end", fields);
  }

  return { status, modelIterations };
}
