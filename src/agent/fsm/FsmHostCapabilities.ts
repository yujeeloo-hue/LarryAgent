
import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  DesktopNotifyInput,
  FsmRunShellInput,
  FsmRunShellResult,
} from "../types.js";
import type {
  OpenAiChatMessage,
  OpenAiToolDefinition,
} from "../../llm/types.js";
import type {
  AssistantMessage,
  Session,
  SessionPlanDoc,
  SessionStatus,
  TextPart,
  ToolCallPart,
} from "../../session/types.js";
import type { SessionPatch } from "../contracts/index.js";
import type { PermissionGateState } from "../../tools/types.js";
import type {
  AwaitSubagentResult,
  ModelRoundResult,
  PrepareModelWindowInput,
  PrepareModelWindowResult,
  PrepareToolsInput,
  PrepareToolsResult,
  ToolsPhaseResult,
  TurnHostCounters,
  TurnRunResult,
  TurnStartOptions,
  TurnStreamLlm,
} from "../turnHost/types.js";
import type { NodeActionExecResult } from "./types.js";

export type FsmHostCapabilities = {
  readonly session: Session;
  readonly isSubagentTurn: boolean;
  readonly createId: () => string;
  readonly gate: PermissionGateState;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: StreamEvent) => void;
  readonly desktopNotify?: (input: DesktopNotifyInput) => void;
  readonly requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
  readonly runShell?: (
    input: FsmRunShellInput,
  ) => Promise<FsmRunShellResult>;
  readonly blackboardGet?: (key: string) => unknown;
  readonly blackboardSet?: (
    key: string,
    value: unknown,
  ) => { ok: true } | { ok: false; error: string };

  buildSkillReflectDigest?(): string;
  getCounters(): TurnHostCounters;
  setCounters(next: Partial<TurnHostCounters>): void;
  resetTurnBudgets(reason: string): void;
  applySessionPatch(patch: SessionPatch): void;
  planDocExists(path: string): boolean;
  readPlanDocContent?(path: string): Promise<string | null>;
  adoptPlanDoc?(path: string, executionRequested: boolean): Promise<SessionPlanDoc | null>;
  deletePlanDoc(path: string): void;

  startTurn(input: TurnStartOptions): Promise<"ok" | TurnRunResult>;
  checkAbort(): boolean;
  enforceBudget(): Promise<"resume" | TurnRunResult>;
  drainPendingSteer(): Promise<boolean>;
  hasPendingSteer(): boolean;

  prepareTools(input?: PrepareToolsInput): PrepareToolsResult;
  prepareModelWindow(
    input: PrepareModelWindowInput,
  ): Promise<PrepareModelWindowResult>;
  streamModelRound(input: {
    llm: TurnStreamLlm;
    messages: OpenAiChatMessage[];
    tools: OpenAiToolDefinition[];
    builtScope?: string;
    hostedTools?: import("../../session/types.js").JsonObject[];
    progressText: string;
  }): Promise<ModelRoundResult>;
  runToolsPhase(
    assistant: AssistantMessage,
    toolCalls: ToolCallPart[],
    options?: {
      disabledTools?: string[];
      allowedTools?: string[];
      extra?: Record<string, unknown>;
    },
  ): Promise<ToolsPhaseResult>;
  appendSyntheticToolRound?(input: {
    toolCalls: ToolCallPart[];
    progressText?: string;
  }): AssistantMessage;
  awaitSubagentBatches(options?: {
    waitIfIncomplete?: boolean;
  }): Promise<AwaitSubagentResult>;

  finalizeEmptyAssistant(input: {
    assistant: AssistantMessage;
    textPart?: TextPart;
    reasoningBuf: string;
  }): void;
  finish(
    status: SessionStatus,
    progressText: string,
    doneReason: "completed" | "cancelled" | "paused" | "error",
    iterations?: number,
  ): Promise<TurnRunResult>;
  emitProgress(text: string): void;
  emitError(message: string): void;
};

export function haltFromTurnResult(
  result: TurnRunResult,
  errorMessage?: string,
): NodeActionExecResult {
  const message =
    errorMessage ??
    (result.status === "error"
      ? "Turn error"
      : result.status === "cancelled"
        ? "Cancelled"
        : undefined);
  return {
    status: "halt",
    ...(message !== undefined ? { errorMessage: message } : {}),
    turnContextPatch: {
      haltResult: result,
      finishedStatus: result.status,
      modelIterations: result.modelIterations,
    },
  };
}
