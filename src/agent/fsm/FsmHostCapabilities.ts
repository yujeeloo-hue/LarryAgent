/**
 * Narrow Host surface for FSM NodeActions (structural subset of TurnHost).
 * Actions must not construct or retain Host — only consume via ExecArgs.
 */

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

/** Capability pick used by FSM Actions — TurnHost satisfies this structurally. */
export type FsmHostCapabilities = {
  readonly session: Session;
  readonly isSubagentTurn: boolean;
  readonly createId: () => string;
  readonly gate: PermissionGateState;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: StreamEvent) => void;
  /** Desktop notification sink (task-done toast/popup via appNotify); main-process only. */
  readonly desktopNotify?: (input: DesktopNotifyInput) => void;
  /**
   * Composer run-mode switch request sink (`NodeActionSetComposerRunMode`);
   * main-process only. Records the request — the turn host applies it in the
   * turn `finally` and may decline (queued prompts / pending plan approval /
   * already on the target mode). Never throws.
   */
  readonly requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
  /**
   * FSM NodeAction shell-execution sink (`NodeActionRunShell`). Runs a shell
   * script (inline body or .sh file) and resolves with a structured result;
   * never throws. Main-process only, injected by sessionRuntime.
   */
  readonly runShell?: (
    input: FsmRunShellInput,
  ) => Promise<FsmRunShellResult>;
  /**
   * FSM session blackboard (`NodeActionWriteBlackboard` / `ReadBlackboard` /
   * Compare): session-scoped key/value store persisted in the sessions
   * table. `blackboardSet` mutates the live session and persists
   * synchronously; returns a named error when the serialized blackboard
   * exceeds the 64KB cap. Main-process only, injected by sessionRuntime;
   * absent in stub / subagent test paths (actions degrade per strict).
   */
  readonly blackboardGet?: (key: string) => unknown;
  readonly blackboardSet?: (
    key: string,
    value: unknown,
  ) => { ok: true } | { ok: false; error: string };

  getCounters(): TurnHostCounters;
  setCounters(next: Partial<TurnHostCounters>): void;
  resetTurnBudgets(reason: string): void;
  applySessionPatch(patch: SessionPatch): void;
  planDocExists(path: string): boolean;
  /** Read the current on-disk document; null means unavailable. Optional for stub hosts. */
  readPlanDocContent?(path: string): Promise<string | null>;
  /** Read and bind metadata for an existing workspace plan without writing the file. */
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
    /** Scope stamped when the window was built. Host drops foreign echo fields. */
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
  /** Runtime-authored tool round (no model request); see TurnHost. Optional for stub hosts. */
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

/** Map a Host terminal turn result into an Action halt. */
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
