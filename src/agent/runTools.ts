import type { SkillActor } from "../skills/types.js";
import type { StreamEvent } from "../llm/streamEvents.js";
import { beginToolTimelineEntry } from "../llm/llmTimeline/recorder.js";
import {
  isFileEditToolName,
  isReadFileToolName,
  isShellToolName,
  type HookRunner,
  type MergedHookResult,
} from "../hooks/index.js";
import {
  agentLogError,
  agentLogInfo,
  agentLogWarn,
  safeJsonForLog,
  truncateForLog,
} from "../logging/agentLog.js";
import { isMcpToolName, MCP_TOOL_PREFIX } from "../mcp/toolNames.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type {
  JsonObject,
  Session,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  ToolResultContentPart,
} from "../session/types.js";
import {
  checkToolPermission,
  permissionDeniedMessage,
  permissionDeniedReturnCode,
} from "../tools/permissions.js";
import { getTool } from "../tools/registry.js";
import { executeTrashRewrite } from "../tools/policy/trashRewrite.js";
import {
  toolApprovalProgressText,
  toolAskProgressText,
  toolRunningProgressText,
} from "../tools/displayMeta.js";
import { resolveToolExecutionSummary } from "../tools/executionSummary.js";
import {
  deferredNameSet,
  isBridgeInScope,
  type ToolBridgeScope,
} from "../tools/toolBridge.js";
import type {
  PermissionGateState,
  RegisteredTool,
  ToolExecuteResult,
} from "../tools/types.js";
import {
  parseToolArgumentsRaw,
  validateToolArguments,
} from "../tools/validateToolArguments.js";
import {
  recordToolInvocation,
  type ToolInvocationReason,
  type ToolInvocationScene,
  type ToolInvocationStatus,
} from "../toolStats/index.js";
import { sealToolCallsWithCancelledResults } from "./sealOrphanToolCalls.js";
import { isToolNamePermitted } from "./policy/toolNameLists.js";
import type { RouteEventPatch, SessionPatch } from "./contracts/index.js";
import type { SessionPlan, SessionPlanDoc } from "../session/types.js";
import {
  registerToolCallAbort,
  unregisterToolCallAbort,
} from "./toolCallAbort.js";
import { isInterruptibleToolName } from "../tools/interruptibleTools.js";
import { emitToolFileWrite } from "../tools/fileWriteEvents.js";

export type RunToolsInput = {
  additionalTools?: RegisteredTool[];
  session: Session;
  assistantMessageId: string;
  toolCalls: ToolCallPart[];
  gate: PermissionGateState;
  createId: () => string;
  /** Persist execution state before side effects and after recording a result. */
  checkpoint?: () => void | Promise<void>;
  signal?: AbortSignal;
  /**
   * One-shot user-prompt interrupt signal (turn host `interruptPort`).
   * Interruptible-class calls fork it into their per-call abort mid-flight;
   * already-running write-class calls finish; unstarted calls are sealed.
   */
  interruptSignal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  /** Resolve vision client for read_image; omit when unavailable. */
  getVisionClient?: () => Promise<
    import("../tools/types.js").VisionClientConfig | null
  >;
  /** Resolve image-generation client for generate_image; omit when unavailable. */
  getImageGenClient?: () => Promise<
    import("../tools/types.js").ImageGenClientConfig | null
  >;
  /** Upload a generate_image input image to object storage (COS URL mode). */
  uploadImageGenInput?: (
    bytes: Uint8Array,
    mimeType: string,
    ext: string,
  ) => Promise<string>;
  /** Upload one read_image target for the tool-role image (direct) path. */
  uploadReadImage?: (input: {
    imagePath: string;
    mimeType: string;
  }) => Promise<{ url: string; key: string } | null>;
  /** Opaque handler fields. Host must not interpret keys. */
  toolContextExtra?: Record<string, unknown>;
  /** Hook runner for this turn; omit to skip hooks. */
  hooks?: HookRunner;
  /** Parent-turn subagent host. */
  subagents?: import("./subagents/types.js").SubagentHost;
  /**
   * List all agent sessions across workspaces (for search_session_history).
   */
  listAgentSessions?: () => Session[];
  /** Summarized session_history records (search_session_history scope). */
  listSessionHistory?: () => import("../session/db/sessionHistoryRepository.js").SessionHistoryRecord[];
  /** Graph library port for the fsm_graph tool (main process only). */
  fsmGraphLibrary?: import("../tools/fsmGraphTool.js").FsmGraphLibraryPort;
  /** Turn-handoff port for the turn_handoff tool (main process only). */
  turnHandoff?: import("../tools/turnHandoffTool.js").TurnHandoffPort;
  /** Loops service port for the loops tool (main process only). */
  loops?: import("../tools/loopsTool.js").LoopsToolPort;
  /** Notification hub port for the notify tool (main process only). */
  notify?: import("../tools/notifyTool.js").NotifyToolPort;
  /** Known workspaces (id + name) for search_session_history scoping. */
  listWorkspaces?: () => { id: string; name: string }[];
  /** Parent session id when this batch runs inside a subagent turn. */
  parentSessionId?: string;
  /** Subagent run id when this batch runs inside a subagent turn. */
  subagentId?: string;
  /** Bridge scope for search/describe/call (subagent denylist etc.). */
  bridgeScope?: ToolBridgeScope;
  /**
   * Reset parent turn model-iteration budget after a successful ask_user.
   */
  resetModelIterations?: () => void;
  /**
   * Optional allowlist patterns (exact or `*` globs) from NodeActionRunTools.
   * When non-empty, calls whose underlying name does not match are rejected.
   */
  allowedTools?: string[];
  /**
   * Phase deny list for the current role/phase (FSM NodeActionDisableTools).
   * Exact names and `*` globs match both the raw call and underlying bridge
   * target. Stale calls to hidden tools still receive a phase-deny result.
   */
  phaseDisabledTools?: string[];
  /** Apply session patches immediately after each successful tool. */
  applySessionPatch?: (patch: SessionPatch) => void;
};

export type RunToolsResult = {
  /** True when abort stopped the batch before all tools finished. */
  cancelled: boolean;
  /** Tool results in this batch with returnCode !== 0. */
  toolFailureCount: number;
  /**
   * Route events enqueued by successful tools this batch (call order;
   * EmitRouteEvent takes last-wins).
   */
  routeEvents: RouteEventPatch[];
  /** Handler results that executed this batch, in call order (with optional receipt). */
  receipts?: ToolCallReceipt[];
  /** Persistence failed; the host must stop this turn without retrying tools. */
  persistenceError?: string;
  /** The tool returned, but local result processing failed; stop the turn. */
  processingError?: string;
};

/** One executed handler result; `receipt` is the tool's model-invisible structured facts. */
export type ToolCallReceipt = {
  toolCallId: string;
  name: string;
  returnCode: number;
  receipt?: JsonObject;
};

class ToolCheckpointError extends Error {
  constructor(readonly stage: "before_execution" | "after_result", cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(stage === "before_execution"
      ? `Unable to persist tool state before execution: ${detail}. The tool was not executed.`
      : `Unable to persist tool result: ${detail}. The in-memory result was preserved; the tool was not retried.`);
  }
}

function emit(onEvent: RunToolsInput["onEvent"], event: StreamEvent): void {
  onEvent?.(event);
}

function touchSession(session: Session, progressText?: string): void {
  if (progressText !== undefined) {
    session.progressText = progressText;
  }
  session.updatedAt = Date.now();
}

function emitProgress(
  session: Session,
  onEvent: RunToolsInput["onEvent"],
  text: string,
  toolName?: string,
): void {
  touchSession(session, text);
  emit(onEvent, { type: "status", status: "tool_running" });
  emit(onEvent, toolName ? { type: "progress", text, toolName } : { type: "progress", text });
}

/** Fan out session snapshot after a tool finishes so the UI can refresh incrementally. */
function emitToolFinished(
  onEvent: RunToolsInput["onEvent"],
  session: Session,
  toolCallId: string,
  toolName: string,
  assistantMessageId: string,
): void {
  touchSession(session);
  emit(onEvent, {
    type: "tool_finished",
    id: toolCallId,
    name: toolName,
    messageId: assistantMessageId,
  });
}

function deniedContent(message: string): ToolResultContentPart[] {
  return [{ type: "text", text: message }];
}

/**
 * Content returned to the model when the user manually stops a single tool
 * call (per-tool abort via the run_shell stop button). The turn keeps going,
 * so the model must know this was a deliberate user cancellation — not a tool
 * failure — and decide whether to retry, adjust, or take a different approach.
 */
function cancelledByUserContent(toolName: string): ToolResultContentPart[] {
  return [
    {
      type: "text",
      text: `The user manually stopped this ${toolName} tool call. The command was terminated and produced no result. You may retry the command, adjust it, or take a different approach.`,
    },
  ];
}

/**
 * Unwrap `tool_call` bridge invocations so hooks / permissions / UI use the
 * underlying tool. Transcript `tool_call` part name stays `tool_call`.
 */
function resolveBridgeInvocation(
  call: ToolCallPart,
  bridgeScope: ToolBridgeScope | undefined,
  additionalTools: RegisteredTool[] = [],
):
  | {
      ok: true;
      tool: RegisteredTool;
      args: Record<string, unknown>;
      argsRaw: string;
      underlyingName: string;
      viaBridge: boolean;
    }
  | { ok: false; message: string; returnCode: number } {
  if (call.name !== "tool_call") {
    const tool = additionalTools.find(t => t.definition.name === call.name) ?? getTool(call.name);
    if (!tool) {
      return {
        ok: false,
        message:
          "Unknown tool. Use search_tools, then tool_describe / tool_call for deferred tools.",
        returnCode: ToolReturnCode.NotFound,
      };
    }
    return {
      ok: true,
      tool,
      args: call.arguments,
      argsRaw: call.argumentsRaw,
      underlyingName: call.name,
      viaBridge: false,
    };
  }

  const bridgeParsed = parseToolArgumentsRaw(call.argumentsRaw);
  if (!bridgeParsed.ok || call.argumentsError) {
    return {
      ok: false,
      message:
        call.argumentsError?.trim() ||
        (!bridgeParsed.ok ? bridgeParsed.error : "") ||
        "Invalid arguments: tool_call arguments must be a JSON object.",
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  const bridgeArgs = bridgeParsed.value;
  const name =
    typeof bridgeArgs.name === "string" ? bridgeArgs.name.trim() : "";
  if (!name) {
    return {
      ok: false,
      message: "tool_call requires a non-empty name.",
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  if (
    name === "tool_call" ||
    name === "tool_describe" ||
    name === "search_tools"
  ) {
    return {
      ok: false,
      message: `Cannot invoke meta tool "${name}" via tool_call.`,
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  if (!deferredNameSet().has(name)) {
    return {
      ok: false,
      message: `Tool "${name}" is not deferred (already in tools[] or unknown). Call it directly, or search_tools for deferred tools.`,
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  if (!isBridgeInScope(name, bridgeScope)) {
    return {
      ok: false,
      message: `Tool "${name}" is out of scope for this agent.`,
      returnCode: ToolReturnCode.PermissionDenied,
    };
  }
  const underlying = getTool(name);
  if (!underlying) {
    return {
      ok: false,
      message: `Unknown tool "${name}".`,
      returnCode: ToolReturnCode.NotFound,
    };
  }
  const argsObj =
    bridgeArgs.arguments &&
    typeof bridgeArgs.arguments === "object" &&
    !Array.isArray(bridgeArgs.arguments)
      ? (bridgeArgs.arguments as Record<string, unknown>)
      : {};
  const schemaCheck = validateToolArguments(
    argsObj as import("../session/types.js").JsonObject,
    underlying.definition.validationParameters ?? underlying.definition.parameters,
  );
  if (!schemaCheck.ok) {
    return {
      ok: false,
      message: schemaCheck.error,
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  return {
    ok: true,
    tool: underlying,
    args: argsObj,
    argsRaw: JSON.stringify(argsObj),
    underlyingName: name,
    viaBridge: true,
  };
}

function appendToolMessageToSession(
  session: Session,
  createId: () => string,
  toolCallId: string,
  content: ToolResultContentPart[],
  returnCode: number,
  executionSummary?: string,
  assistantMessageId?: string,
): void {
  const message: ToolMessage = {
    id: createId(),
    role: "tool",
    toolCallId,
    createdAt: Date.now(),
    parts: [
      {
        type: "tool_result",
        toolCallId,
        content,
        returnCode,
        ...(executionSummary ? { executionSummary } : {}),
      },
    ],
  };
  const ownerIndex = assistantMessageId
    ? session.messages.findIndex((item) => item.role === "assistant" && item.id === assistantMessageId)
    : -1;
  if (ownerIndex < 0) {
    session.messages.push(message);
  } else {
    let insertAt = ownerIndex + 1;
    while (session.messages[insertAt]?.role === "tool") insertAt += 1;
    session.messages.splice(insertAt, 0, message);
  }
  session.updatedAt = Date.now();
}

/** Result ids are scoped to the assistant that issued them, not the session. */
function toolResultsForAssistant(
  session: Session,
  assistantMessageId: string,
  unanchoredStart: number,
): Map<string, ToolResultPart> {
  const ownerIndex = session.messages.findIndex(
    (message) => message.role === "assistant" && message.id === assistantMessageId,
  );
  const results = new Map<string, ToolResultPart>();
  for (let i = ownerIndex < 0 ? unanchoredStart : ownerIndex + 1; i < session.messages.length; i += 1) {
    const message = session.messages[i]!;
    if (message.role === "assistant") break;
    if (message.role !== "tool") continue;
    for (const part of message.parts) {
      if (part.type === "tool_result") results.set(part.toolCallId, part);
    }
  }
  return results;
}

function toolArgsAsObject(call: ToolCallPart): JsonObject {
  if (
    call.arguments &&
    typeof call.arguments === "object" &&
    !Array.isArray(call.arguments)
  ) {
    return call.arguments as JsonObject;
  }
  return {};
}

function summaryForToolResult(
  tool: RegisteredTool | undefined,
  call: ToolCallPart,
  content: ToolResultContentPart[],
  returnCode: number,
): string {
  return resolveToolExecutionSummary(tool, call.name, {
    args: toolArgsAsObject(call),
    returnCode,
    content,
  });
}

function previewToolContent(content: ToolResultContentPart[]): string {
  const texts = content
    .filter(
      (p): p is Extract<ToolResultContentPart, { type: "text" }> =>
        p.type === "text",
    )
    .map((p) => p.text);
  if (texts.length === 0) {
    return `[${content.length} part(s)]`;
  }
  return truncateForLog(texts.join("\n"));
}

/**
 * Stamp `durationMs` onto the transcript's owning tool_call part. Runs at
 * every terminal outcome (recordStats call sites) so the renderer's Thinking
 * tool record and any snapshot consumer read one number. The detached
 * `toolCalls` copies and bridged `effectiveCall` share the id; only the
 * persisted assistant part needs the stamp.
 */
function stampToolCallDurationMs(
  session: Session,
  toolCallId: string,
  durationMs: number,
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "tool_call" && part.id === toolCallId) {
        part.durationMs = durationMs;
        return;
      }
    }
  }
}

function recordStats(
  input: RunToolsInput,
  call: ToolCallPart,
  startedAt: number,
  outcome: {
    status: ToolInvocationStatus;
    reason: ToolInvocationReason;
    returnCode?: number;
    scene?: ToolInvocationScene;
  },
): void {
  const mcpServerId = mcpServerIdFromToolName(call.name);
  stampToolCallDurationMs(input.session, call.id, Math.max(0, Date.now() - startedAt));
  recordToolInvocation({
    sessionId: input.session.id,
    ...(input.parentSessionId
      ? { parentSessionId: input.parentSessionId }
      : {}),
    ...(input.subagentId ? { subagentId: input.subagentId } : {}),
    toolCallId: call.id,
    name: call.name,
    isMcp: isMcpToolName(call.name),
    ...(mcpServerId ? { mcpServerId } : {}),
    status: outcome.status,
    reason: outcome.reason,
    ...(outcome.returnCode != null ? { returnCode: outcome.returnCode } : {}),
    startedAt,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(outcome.scene ? { scene: outcome.scene } : {}),
  });
}

function failureSceneFromCall(
  call: ToolCallPart,
  extras?: Partial<ToolInvocationScene>,
): ToolInvocationScene {
  return {
    ...(typeof call.arguments === "object" &&
    call.arguments !== null &&
    !Array.isArray(call.arguments)
      ? { arguments: call.arguments as JsonObject }
      : {}),
    ...(call.argumentsRaw ? { argumentsRaw: call.argumentsRaw } : {}),
    ...extras,
  };
}

function mcpServerIdFromToolName(name: string): string | undefined {
  if (!isMcpToolName(name)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx <= 0) return undefined;
  return rest.slice(0, idx);
}

function shellCommandFromArgs(args: JsonObject): string | undefined {
  return typeof args.command === "string" ? args.command : undefined;
}

function applyUpdatedInput(call: ToolCallPart, updated: JsonObject): void {
  call.arguments = updated;
  try {
    call.argumentsRaw = JSON.stringify(updated);
  } catch {
    call.argumentsRaw = "{}";
  }
}

function appendAdditionalContext(
  content: ToolResultContentPart[],
  context: string | undefined,
): ToolResultContentPart[] {
  const trimmed = context?.trim();
  if (!trimmed) return content;
  return [
    ...content,
    { type: "text", text: `\n[Hook context]\n${trimmed}` },
  ];
}

/** JSON for the timeline raw panel; never throws into the tool path. */
function safeTimelineJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function applyOutputRewrite(
  content: ToolResultContentPart[],
  rewrite: MergedHookResult["updatedMcpToolOutput"],
): ToolResultContentPart[] {
  if (rewrite === undefined) return content;
  if (typeof rewrite === "string") {
    return [{ type: "text", text: rewrite }];
  }
  if (Array.isArray(rewrite)) return rewrite;
  return content;
}

function hookDenyMessage(
  toolName: string,
  result: MergedHookResult,
): string {
  return (
    result.agentMessage?.trim() ||
    result.userMessage?.trim() ||
    `Permission denied: hook blocked ${toolName}.`
  );
}

async function runPreToolHooks(input: {
  hooks: HookRunner;
  session: Session;
  call: ToolCallPart;
  args: JsonObject;
}): Promise<MergedHookResult> {
  const { hooks, session, call, args } = input;
  const shellCommand = shellCommandFromArgs(args);
  const mcpServerId = mcpServerIdFromToolName(call.name);

  const basePayload = {
    sessionId: session.id,
    workspacePath: session.workspacePath,
    tool_name: call.name,
    tool_call_id: call.id,
    tool_input: args,
    ...(shellCommand ? { command: shellCommand } : {}),
    ...(mcpServerId ? { mcp_server_id: mcpServerId } : {}),
  };

  let merged = await hooks.run("preToolUse", basePayload);
  if (merged.denied) return merged;

  // Apply input rewrite before specialized events so they see updated args
  let effectiveArgs = merged.updatedInput ?? args;
  if (merged.updatedInput) {
    applyUpdatedInput(call, merged.updatedInput);
  }

  const specializedPayload = {
    ...basePayload,
    tool_input: effectiveArgs,
    ...(shellCommandFromArgs(effectiveArgs)
      ? { command: shellCommandFromArgs(effectiveArgs) }
      : {}),
  };

  if (isShellToolName(call.name)) {
    const next = await hooks.run("beforeShellExecution", specializedPayload);
    merged = {
      ...merged,
      permission:
        next.permission === "deny"
          ? "deny"
          : next.permission === "ask" || merged.permission === "ask"
            ? "ask"
            : merged.permission,
      denied: merged.denied || next.denied,
      ...(next.updatedInput ? { updatedInput: next.updatedInput } : {}),
      ...(next.additionalContext
        ? {
            additionalContext: merged.additionalContext
              ? `${merged.additionalContext}\n${next.additionalContext}`
              : next.additionalContext,
          }
        : {}),
      ...(next.userMessage ? { userMessage: next.userMessage } : {}),
      ...(next.agentMessage ? { agentMessage: next.agentMessage } : {}),
    };
    if (next.updatedInput) {
      applyUpdatedInput(call, next.updatedInput);
      effectiveArgs = next.updatedInput;
    }
    if (merged.denied) return merged;
  }

  if (isMcpToolName(call.name)) {
    const next = await hooks.run("beforeMCPExecution", {
      ...specializedPayload,
      tool_input: effectiveArgs,
    });
    merged = foldPreResults(merged, next);
    if (next.updatedInput) {
      applyUpdatedInput(call, next.updatedInput);
      effectiveArgs = next.updatedInput;
    }
    if (merged.denied) return merged;
  }

  if (isReadFileToolName(call.name)) {
    const next = await hooks.run("beforeReadFile", {
      ...specializedPayload,
      tool_input: effectiveArgs,
    });
    merged = foldPreResults(merged, next);
    if (next.updatedInput) {
      applyUpdatedInput(call, next.updatedInput);
    }
  }

  return merged;
}

function foldPreResults(
  a: MergedHookResult,
  b: MergedHookResult,
): MergedHookResult {
  return {
    permission:
      b.permission === "deny"
        ? "deny"
        : b.permission === "ask" || a.permission === "ask"
          ? "ask"
          : a.permission,
    denied: a.denied || b.denied,
    ...(b.updatedInput
      ? { updatedInput: b.updatedInput }
      : a.updatedInput
        ? { updatedInput: a.updatedInput }
        : {}),
    ...(b.additionalContext || a.additionalContext
      ? {
          additionalContext: [a.additionalContext, b.additionalContext]
            .filter(Boolean)
            .join("\n"),
        }
      : {}),
    ...(b.userMessage
      ? { userMessage: b.userMessage }
      : a.userMessage
        ? { userMessage: a.userMessage }
        : {}),
    ...(b.agentMessage
      ? { agentMessage: b.agentMessage }
      : a.agentMessage
        ? { agentMessage: a.agentMessage }
        : {}),
    ...(b.updatedMcpToolOutput !== undefined
      ? { updatedMcpToolOutput: b.updatedMcpToolOutput }
      : a.updatedMcpToolOutput !== undefined
        ? { updatedMcpToolOutput: a.updatedMcpToolOutput }
        : {}),
  };
}

async function runPostToolHooks(input: {
  hooks: HookRunner;
  session: Session;
  call: ToolCallPart;
  args: JsonObject;
  result: ToolExecuteResult;
  success: boolean;
  errorMessage?: string;
}): Promise<MergedHookResult> {
  const { hooks, session, call, args, result, success } = input;
  const shellCommand = shellCommandFromArgs(args);
  const mcpServerId = mcpServerIdFromToolName(call.name);
  const basePayload = {
    sessionId: session.id,
    workspacePath: session.workspacePath,
    tool_name: call.name,
    tool_call_id: call.id,
    tool_input: args,
    tool_output: result.content,
    return_code: result.returnCode,
    ...(shellCommand ? { command: shellCommand } : {}),
    ...(mcpServerId ? { mcp_server_id: mcpServerId } : {}),
    ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
  };

  let merged: MergedHookResult = {
    permission: "allow",
    denied: false,
  };

  if (!success) {
    return hooks.run("postToolUseFailure", basePayload);
  }

  if (isShellToolName(call.name)) {
    const after = await hooks.run("afterShellExecution", basePayload);
    merged = foldPreResults(merged, after);
  }
  if (isMcpToolName(call.name)) {
    const after = await hooks.run("afterMCPExecution", basePayload);
    merged = foldPreResults(merged, after);
  }
  if (isFileEditToolName(call.name)) {
    const after = await hooks.run("afterFileEdit", basePayload);
    merged = foldPreResults(merged, after);
  }

  const post = await hooks.run("postToolUse", basePayload);
  return foldPreResults(merged, post);
}

/**
 * Run tool calls sequentially with hooks + permission checks.
 * On deny/unknown tool: write tool_result and continue.
 * On abort: do not run remaining tools.
 */
export async function runTools(input: RunToolsInput): Promise<RunToolsResult> {
  const {
    session,
    assistantMessageId,
    toolCalls,
    gate,
    createId,
    signal,
    interruptSignal,
    onEvent,
    getVisionClient,
    getImageGenClient,
    uploadImageGenInput,
    uploadReadImage,
    toolContextExtra,
    hooks,
    subagents,
    listAgentSessions,
    listSessionHistory,
    listWorkspaces,
    fsmGraphLibrary,
    turnHandoff,
    loops,
    notify,
    bridgeScope,
    resetModelIterations,
    subagentId,
  } = input;

  const routeEvents: RouteEventPatch[] = [];
  const receipts: ToolCallReceipt[] = [];
  const unanchoredStart = session.messages.length;
  const owner = session.messages.find(
    (message) => message.role === "assistant" && message.id === assistantMessageId,
  );
  const scopedResults = () => toolResultsForAssistant(session, assistantMessageId, unanchoredStart);
  const failureCount = (): number => {
    const ids = new Set(toolCalls.map((call) => call.id));
    return [...scopedResults()].filter(([id, result]) => ids.has(id) && result.returnCode !== 0).length;
  };

  function setToolCallStatus(part: ToolCallPart, status: ToolCallPart["status"]): void {
    part.status = status;
    // A resumed caller may supply detached copies. Persist the owning message's
    // status too, so the checkpoint never records a still-pending execution.
    for (const candidate of [...(owner?.parts ?? []), ...toolCalls]) {
      if (candidate.type === "tool_call" && candidate.id === part.id) candidate.status = status;
    }
  }

  async function checkpoint(stage: ToolCheckpointError["stage"]): Promise<void> {
    try {
      await input.checkpoint?.();
    } catch (error) {
      throw new ToolCheckpointError(stage, error);
    }
  }

  async function appendToolMessage(
    resultSession: Session,
    resultCreateId: () => string,
    toolCallId: string,
    content: ToolResultContentPart[],
    returnCode: number,
    executionSummary?: string,
  ): Promise<void> {
    appendToolMessageToSession(resultSession, resultCreateId, toolCallId, content,
      returnCode, executionSummary, assistantMessageId);
    await checkpoint("after_result");
  }

  async function checkpointSealedBatch(cancelled: boolean): Promise<RunToolsResult> {
    try {
      await checkpoint("after_result");
      return { cancelled, toolFailureCount: 0, routeEvents };
    } catch (error) {
      if (!(error instanceof ToolCheckpointError)) throw error;
      emit(onEvent, { type: "error", message: error.message });
      return { cancelled: false, toolFailureCount: failureCount(), routeEvents,
        persistenceError: error.message };
    }
  }

  const cancelBatch = async (reason: string): Promise<RunToolsResult> => {
    const sealed = sealToolCallsWithCancelledResults(
      session,
      createId,
      toolCalls,
      "Cancelled",
      assistantMessageId,
    );
    for (const call of sealed) {
      emitToolFinished(onEvent, session, call.id, call.name, assistantMessageId);
    }
    if (sealed.length > 0) {
      agentLogWarn("tool.cancelled_batch_sealed", {
        sessionId: session.id,
        sealed: sealed.length,
        reason,
        toolCallIds: sealed.map((c) => c.id),
      });
    }
    return sealed.length > 0 ? checkpointSealedBatch(true)
      : { cancelled: true, toolFailureCount: 0, routeEvents };
  };

  const interruptBatch = async (): Promise<RunToolsResult> => {
    const sealed = sealToolCallsWithCancelledResults(
      session, createId, toolCalls,
      "Interrupted by user message — not executed",
      assistantMessageId,
    );
    for (const call of sealed) {
      emitToolFinished(onEvent, session, call.id, call.name, assistantMessageId);
    }
    // Completed writes retain their actual results. Only unstarted calls
    // are sealed; this is a round boundary, never a turn cancellation.
    return sealed.length > 0 ? checkpointSealedBatch(false)
      : { cancelled: false, toolFailureCount: 0, routeEvents };
  };

  const batchExtra: {
    planSnapshot: SessionPlan | null;
    planDocSnapshot: SessionPlanDoc | null;
    requirePlanDocForCreatePlan?: boolean;
  } & Record<string, unknown> = {
    planSnapshot: session.plan ?? null,
    planDocSnapshot: session.planDoc ?? null,
    ...(input.toolContextExtra ?? {}),
  };

  const phaseDisabledTools = (input.phaseDisabledTools ?? []).filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );

  for (const call of toolCalls) {
    try {
    const existing = scopedResults().get(call.id);
    if (existing) {
      setToolCallStatus(call, existing.returnCode === ToolReturnCode.Success ? "done"
        : existing.returnCode === ToolReturnCode.Cancelled ? "cancelled" : "error");
      continue;
    }
    const recordedCall = owner?.parts.find((part) => part.type === "tool_call" &&
      part.id === call.id && part.status !== "pending");
    const priorStatus = recordedCall?.type === "tool_call" ? recordedCall.status : call.status;
    if (priorStatus !== "pending") {
      const message = `Execution outcome is unknown: this call was already marked ${priorStatus} but has no recorded result. It was not retried. Verify any prior side effects before requesting another execution.`;
      const content = deniedContent(message);
      setToolCallStatus(call, "error");
      await appendToolMessage(session, createId, call.id, content, ToolReturnCode.GenericFailure,
        summaryForToolResult(getTool(call.name), call, content, ToolReturnCode.GenericFailure));
      emitToolFinished(onEvent, session, call.id, call.name, assistantMessageId);
      continue;
    }
    if (signal?.aborted) {
      setToolCallStatus(call, "cancelled");
      agentLogWarn("tool.cancelled", {
        sessionId: session.id,
        toolCallId: call.id,
        name: call.name,
        reason: "abort_before_start",
      });
      recordStats(input, call, Date.now(), {
        status: "cancelled",
        reason: "abort_before_start",
        scene: failureSceneFromCall(call, {
          errorMessage: "Aborted before tool start",
        }),
      });
      return cancelBatch("abort_before_start");
    }
    if (interruptSignal?.aborted) return interruptBatch();

    emitProgress(session, onEvent, toolRunningProgressText(call.name), call.name);

    const startedAt = Date.now();
    agentLogInfo("tool.start", {
      sessionId: session.id,
      toolCallId: call.id,
      name: call.name,
      arguments: safeJsonForLog(call.arguments),
    });

    // Parse outer args first (needed for non-bridge and for tool_call unwrap).
    const parsedArgs = parseToolArgumentsRaw(call.argumentsRaw);
    if (!parsedArgs.ok || call.argumentsError) {
      let message =
        call.argumentsError?.trim() ||
        (!parsedArgs.ok ? parsedArgs.error : "") ||
        "Invalid arguments: tool arguments must be a JSON object.";
      const raw = call.argumentsRaw.trim();
      if (raw.length > 0 && !parsedArgs.ok) {
        const looksTruncated =
          !raw.endsWith("}") &&
          (raw.includes('"content"') ||
            raw.includes('"patch"') ||
            raw.includes('"patch_text"') ||
            raw.includes('"old_string"') ||
            raw.includes('"new_string"'));
        if (looksTruncated) {
          message =
            "Invalid arguments: tool arguments JSON was truncated mid-stream. " +
            "Retry with a smaller write_file chunk, or a shorter old_string / smaller V4A patch.";
        }
      }
      call.arguments = parsedArgs.value;
      call.argumentsError = message;
      setToolCallStatus(call, "error");
      const content = deniedContent(message);
      const returnCode = ToolReturnCode.InvalidArguments;
      await appendToolMessage(
        session,
        createId,
        call.id,
        content,
        returnCode,
        summaryForToolResult(undefined, call, content, returnCode),
      );
      agentLogWarn("tool.denied", {
        sessionId: session.id,
        toolCallId: call.id,
        name: call.name,
        reason: "invalid_arguments_json",
        returnCode: ToolReturnCode.InvalidArguments,
        durationMs: Date.now() - startedAt,
      });
      recordStats(input, call, startedAt, {
        status: "invalid",
        reason: "invalid_arguments_json",
        returnCode: ToolReturnCode.InvalidArguments,
        scene: failureSceneFromCall(call, {
          errorMessage: message,
          resultText: message,
        }),
      });
      emitToolFinished(onEvent, session, call.id, call.name, assistantMessageId);
      continue;
    }
    call.arguments = parsedArgs.value;
    delete call.argumentsError;

    const resolved = resolveBridgeInvocation(call, bridgeScope, input.additionalTools);
    if (!resolved.ok) {
      const content = deniedContent(resolved.message);
      const returnCode = resolved.returnCode;
      setToolCallStatus(call, "error");
      await appendToolMessage(
        session,
        createId,
        call.id,
        content,
        returnCode,
        summaryForToolResult(undefined, call, content, returnCode),
      );
      agentLogWarn("tool.denied", {
        sessionId: session.id,
        toolCallId: call.id,
        name: call.name,
        reason: "bridge_resolve_failed",
        returnCode,
        durationMs: Date.now() - startedAt,
      });
      recordStats(input, call, startedAt, {
        status: "invalid",
        reason: "bridge_resolve_failed",
        returnCode,
        scene: failureSceneFromCall(call, {
          errorMessage: resolved.message,
          resultText: resolved.message,
        }),
      });
      emitToolFinished(onEvent, session, call.id, call.name, assistantMessageId);
      continue;
    }

    const registered = resolved.tool;
    const underlyingName = resolved.underlyingName;
    /** Hooks / perms / execute / stats use the underlying tool when bridged. */
    const effectiveCall: ToolCallPart = resolved.viaBridge
      ? {
          ...call,
          name: underlyingName,
          arguments: resolved.args as JsonObject,
          argumentsRaw: resolved.argsRaw,
        }
      : call;
    let executeArgs = effectiveCall.arguments as JsonObject;

    // Configured allowlist (PrepareTools → nodeContext.allowTools): underlying name.
    const allowedTools = input.allowedTools;
    if (
      Array.isArray(allowedTools) &&
      allowedTools.length > 0 &&
      !isToolNamePermitted(underlyingName, { allowTools: allowedTools })
    ) {
      const message = `Tool "${underlyingName}" is not on the current allowlist and cannot run.`;
      const content = deniedContent(message);
      const returnCode = ToolReturnCode.PermissionDenied;
      setToolCallStatus(call, "error");
      await appendToolMessage(
        session,
        createId,
        call.id,
        content,
        returnCode,
        summaryForToolResult(registered, effectiveCall, content, returnCode),
      );
      agentLogWarn("tool.allowlist_denied", {
        sessionId: session.id,
        toolCallId: call.id,
        name: underlyingName,
        returnCode,
        durationMs: Date.now() - startedAt,
      });
      recordStats(input, effectiveCall, startedAt, {
        status: "denied",
        reason: "allowlist_denied",
        returnCode,
        scene: failureSceneFromCall(effectiveCall, {
          errorMessage: message,
          resultText: message,
        }),
      });
      emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
      continue;
    }

    // Models can still emit hidden calls from history. Check the bridge name
    // as well as its target so disabling tool_call cannot be bypassed by unwrap.
    const phaseDisabledName = [call.name, underlyingName].find(
      (name) => !isToolNamePermitted(name, { denyTools: phaseDisabledTools }),
    );
    if (phaseDisabledName) {
      const message = `Tool "${phaseDisabledName}" is not available in the current phase. It is disabled for this role; choose a tool that fits the current phase, or move to the phase where it is allowed.`;
      const content = deniedContent(message);
      const returnCode = ToolReturnCode.PermissionDenied;
      setToolCallStatus(call, "error");
      await appendToolMessage(
        session,
        createId,
        call.id,
        content,
        returnCode,
        summaryForToolResult(registered, effectiveCall, content, returnCode),
      );
      agentLogWarn("tool.phase_disabled", {
        sessionId: session.id,
        toolCallId: call.id,
        name: underlyingName,
        returnCode,
        durationMs: Date.now() - startedAt,
      });
      recordStats(input, effectiveCall, startedAt, {
        status: "denied",
        reason: "phase_disabled",
        returnCode,
        scene: failureSceneFromCall(effectiveCall, {
          errorMessage: message,
          resultText: message,
        }),
      });
      emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
      continue;
    }

    // Subagent / role bridge scope: denylist applies to direct calls too.
    if (
      bridgeScope &&
      call.name !== "search_tools" &&
      call.name !== "tool_describe" &&
      call.name !== "tool_call" &&
      !isBridgeInScope(underlyingName, bridgeScope)
    ) {
      const message = `Tool "${underlyingName}" is out of scope for this agent.`;
      const content = deniedContent(message);
      const returnCode = ToolReturnCode.PermissionDenied;
      setToolCallStatus(call, "error");
      await appendToolMessage(
        session,
        createId,
        call.id,
        content,
        returnCode,
        summaryForToolResult(registered, effectiveCall, content, returnCode),
      );
      agentLogWarn("tool.denied", {
        sessionId: session.id,
        toolCallId: call.id,
        name: underlyingName,
        reason: "bridge_scope_denied",
        returnCode,
        durationMs: Date.now() - startedAt,
      });
      recordStats(input, effectiveCall, startedAt, {
        status: "denied",
        reason: "bridge_scope_denied",
        returnCode,
        scene: failureSceneFromCall(effectiveCall, {
          errorMessage: message,
          resultText: message,
        }),
      });
      emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
      continue;
    }

    try { gate.authorizeTool?.(underlyingName, executeArgs); }
    catch (error) {
      if (signal?.aborted) return cancelBatch("abort_during_authorization");
      const message = error instanceof Error ? error.message : String(error);
      const content = deniedContent(message);
      setToolCallStatus(call,"error");
      await appendToolMessage(session,createId,call.id,content,ToolReturnCode.PermissionDenied,summaryForToolResult(registered,effectiveCall,content,ToolReturnCode.PermissionDenied));
      emitToolFinished(onEvent,session,call.id,underlyingName,assistantMessageId);
      continue;
    }
    emitProgress(session, onEvent, toolRunningProgressText(underlyingName), underlyingName);

    const progressGate: PermissionGateState = {
      get fullPermissionsEnabled() {
        return gate.fullPermissionsEnabled;
      },
      get reviewHighRisk() {
        return gate.reviewHighRisk === true;
      },
      enableFullPermissions: () => {
        gate.enableFullPermissions();
        emit(onEvent, { type: "full_permissions", enabled: true });
      },
      requestConfirmation: async (req) => {
        emitProgress(
          session,
          onEvent,
          toolApprovalProgressText(req.toolName),
          req.toolName,
        );
        return gate.requestConfirmation(req);
      },
      requestUserAsk: async (req) => {
        emitProgress(
          session,
          onEvent,
          toolAskProgressText(underlyingName),
          underlyingName,
        );
        return gate.requestUserAsk(req);
      },
    };

    // --- Hooks: pre (underlying name when bridged) ---
    let preHook: MergedHookResult | null = null;
    if (hooks) {
      preHook = await runPreToolHooks({
        hooks,
        session,
        call: effectiveCall,
        args: executeArgs,
      });
      if (signal?.aborted) {
        setToolCallStatus(call, "cancelled");
        agentLogWarn("tool.cancelled", {
          sessionId: session.id,
          toolCallId: call.id,
          name: underlyingName,
          reason: "abort_during_hook",
        });
        recordStats(input, effectiveCall, startedAt, {
          status: "cancelled",
          reason: "abort_during_hook",
          scene: failureSceneFromCall(effectiveCall, {
            errorMessage: "Aborted during pre-tool hook",
          }),
        });
        return cancelBatch("abort_during_hook");
      }
      if (preHook.denied || preHook.permission === "deny") {
        const message = hookDenyMessage(underlyingName, preHook);
        const content = deniedContent(message);
        const returnCode = ToolReturnCode.Cancelled;
        setToolCallStatus(call, "cancelled");
        await appendToolMessage(
          session,
          createId,
          call.id,
          content,
          returnCode,
          summaryForToolResult(registered, effectiveCall, content, returnCode),
        );
        emit(onEvent, {
          type: "progress",
          text: `Hook denied ${underlyingName}`,
        });
        agentLogWarn("tool.denied", {
          sessionId: session.id,
          toolCallId: call.id,
          name: underlyingName,
          reason: "hook_denied",
          returnCode: ToolReturnCode.Cancelled,
          durationMs: Date.now() - startedAt,
        });
        recordStats(input, effectiveCall, startedAt, {
          status: "denied",
          reason: "hook_denied",
          returnCode: ToolReturnCode.Cancelled,
          scene: failureSceneFromCall(effectiveCall, {
            errorMessage: message,
            resultText: message,
            hookMessage: message,
          }),
        });
        emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
        continue;
      }
      if (preHook.permission === "ask") {
        const approved = await progressGate.requestConfirmation({
          toolName: underlyingName,
          arguments: executeArgs,
          source: "hook_ask",
        });
        if (signal?.aborted) {
          setToolCallStatus(call, "cancelled");
          agentLogWarn("tool.cancelled", {
            sessionId: session.id,
            toolCallId: call.id,
            name: underlyingName,
            reason: "abort_during_hook",
          });
          recordStats(input, effectiveCall, startedAt, {
            status: "cancelled",
            reason: "abort_during_hook",
            scene: failureSceneFromCall(effectiveCall, {
              errorMessage: "Aborted during hook ask",
            }),
          });
          return cancelBatch("abort_during_hook");
        }
        if (!approved) {
          const message =
            preHook.userMessage?.trim() ||
            `Permission denied: ${underlyingName} was not approved.`;
          const content = deniedContent(message);
          const returnCode = ToolReturnCode.Cancelled;
          setToolCallStatus(call, "cancelled");
          await appendToolMessage(
            session,
            createId,
            call.id,
            content,
            returnCode,
            summaryForToolResult(registered, effectiveCall, content, returnCode),
          );
          agentLogWarn("tool.denied", {
            sessionId: session.id,
            toolCallId: call.id,
            name: underlyingName,
            reason: "hook_ask_denied",
            returnCode: ToolReturnCode.Cancelled,
            durationMs: Date.now() - startedAt,
          });
          recordStats(input, effectiveCall, startedAt, {
            status: "denied",
            reason: "hook_ask_denied",
            returnCode: ToolReturnCode.Cancelled,
            scene: failureSceneFromCall(effectiveCall, {
              errorMessage: message,
              resultText: message,
              hookMessage: message,
            }),
          });
          emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
          continue;
        }
      }
    }

    executeArgs = effectiveCall.arguments as JsonObject;

    // Non-bridge: schema-check args. Bridge path already validated underlying.
    if (!resolved.viaBridge) {
      const schemaCheck = validateToolArguments(
        executeArgs,
        registered.definition.validationParameters ?? registered.definition.parameters,
      );
      if (!schemaCheck.ok) {
        setToolCallStatus(call, "error");
        const content = deniedContent(schemaCheck.error);
        const returnCode = ToolReturnCode.InvalidArguments;
        await appendToolMessage(
          session,
          createId,
          call.id,
          content,
          returnCode,
          summaryForToolResult(registered, effectiveCall, content, returnCode),
        );
        agentLogWarn("tool.denied", {
          sessionId: session.id,
          toolCallId: call.id,
          name: underlyingName,
          reason: "invalid_arguments_schema",
          returnCode: ToolReturnCode.InvalidArguments,
          durationMs: Date.now() - startedAt,
          message: schemaCheck.error,
        });
        recordStats(input, effectiveCall, startedAt, {
          status: "invalid",
          reason: "invalid_arguments_schema",
          returnCode: ToolReturnCode.InvalidArguments,
          scene: failureSceneFromCall(effectiveCall, {
            errorMessage: schemaCheck.error,
            resultText: schemaCheck.error,
          }),
        });
        emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
        continue;
      }
    }

    const decision = await checkToolPermission({
      toolName: registered.definition.name,
      defaultLevel: registered.definition.defaultPermissionLevel,
      arguments: executeArgs,
      gate: progressGate,
      ...(registered.definition.assessRisk
        ? { assessRisk: registered.definition.assessRisk }
        : {}),
      workspacePath: session.workspacePath,
    });

    if (signal?.aborted) {
      setToolCallStatus(call, "cancelled");
      agentLogWarn("tool.cancelled", {
        sessionId: session.id,
        toolCallId: call.id,
        name: underlyingName,
        reason: "abort_during_permission",
      });
      recordStats(input, effectiveCall, startedAt, {
        status: "cancelled",
        reason: "abort_during_permission",
        scene: failureSceneFromCall(effectiveCall, {
          errorMessage: "Aborted during permission check",
          permissionLevel: registered.definition.defaultPermissionLevel,
        }),
      });
      return cancelBatch("abort_during_permission");
    }

    if (!decision.allowed) {
      const returnCode = permissionDeniedReturnCode(decision.reason);
      const message = permissionDeniedMessage(underlyingName, decision);
      const content = deniedContent(message);
      setToolCallStatus(
        call,
        returnCode === ToolReturnCode.Cancelled ? "cancelled" : "error",
      );
      await appendToolMessage(
        session,
        createId,
        call.id,
        content,
        returnCode,
        summaryForToolResult(registered, effectiveCall, content, returnCode),
      );
      agentLogWarn("tool.denied", {
        sessionId: session.id,
        toolCallId: call.id,
        name: underlyingName,
        reason: decision.reason,
        returnCode,
        durationMs: Date.now() - startedAt,
      });
      recordStats(input, effectiveCall, startedAt, {
        status: "denied",
        reason:
          decision.reason === "full_permissions_required"
            ? "full_permissions_required"
            : decision.reason === "risk_blocked"
              ? "risk_blocked"
              : "user_denied",
        returnCode,
        scene: failureSceneFromCall(effectiveCall, {
          errorMessage: message,
          resultText: message,
          permissionLevel: registered.definition.defaultPermissionLevel,
        }),
      });
      emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
      continue;
    }

    // Hooks and permission cards await user code. A correction may have
    // arrived during either wait: approval must not start obsolete work.
    if (interruptSignal?.aborted) return interruptBatch();

    // Fork a per-call abort signal from the turn signal so a single running
    // tool (e.g. a hanging run_shell) can be stopped without cancelling the
    // whole turn. Registered by toolCallId for the renderer's
    // agent:abortToolCall IPC; the turn signal still cascades into it.
    const callAbort = new AbortController();
    const onTurnAbort = () => callAbort.abort();
    if (signal) {
      if (signal.aborted) callAbort.abort();
      else signal.addEventListener("abort", onTurnAbort, { once: true });
    }
    // Interrupt cascade (interrupt-mode prompts): only interruptible-class
    // calls observe the interrupt signal — write-class tools run to
    // completion and the prompt lands at the round boundary instead.
    const onInterruptAbort = () => callAbort.abort();
    if (interruptSignal && isInterruptibleToolName(underlyingName)) {
      if (interruptSignal.aborted) callAbort.abort();
      else {
        interruptSignal.addEventListener("abort", onInterruptAbort, {
          once: true,
        });
      }
    }
    registerToolCallAbort(session.id, call.id, callAbort);
    // Dev Panel Timeline: mark the true execution window (post permission /
    // hook waits) on the Tools track.
    const timelineArgsRaw = safeTimelineJson(executeArgs);
    const timelineTool = beginToolTimelineEntry({
      sessionId: session.id,
      name: underlyingName,
      toolCallId: call.id,
      ...(timelineArgsRaw !== undefined ? { argsRaw: timelineArgsRaw } : {}),
    });
    let timelineError: string | undefined;
    let timelineResultRaw: string | undefined;
    let timelineReturnCode: number | undefined;
    let executedResult: ToolExecuteResult | undefined;
    try {
      // Re-assert running label after any permission / hook ask wait.
      gate.authorizeTool?.(underlyingName, executeArgs);
      emitProgress(session, onEvent, toolRunningProgressText(underlyingName), underlyingName);
      setToolCallStatus(call, "running");
      if (input.checkpoint && !owner?.parts.some(
        (part) => part.type === "tool_call" && part.id === call.id,
      )) {
        throw new ToolCheckpointError("before_execution",
          new Error("Missing owning assistant/tool call in the persisted transcript"));
      }
      await checkpoint("before_execution");
      // Persistence can wait on disk. Recheck cancellation before side effects.
      if (signal?.aborted) {
        setToolCallStatus(call, "pending");
        return cancelBatch("abort_before_execute");
      }
      if (interruptSignal?.aborted) {
        setToolCallStatus(call, "pending");
        return interruptBatch();
      }
      if (callAbort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      gate.beforeToolExecute?.(underlyingName, executeArgs);
      if (decision.rewrite) for (const target of decision.rewrite.targets) {
        // The native Trash adapter bypasses the shell process. It must still
        // satisfy Coco's write permission as well as its path boundary.
        gate.authorizeTool?.("write_file", { path: target, content: "" });
        gate.assertPath?.(target);
      }
      // Shell Safe Mode rm → Trash rewrite: skip the shell entirely.
      const result =
        decision.rewrite && isShellToolName(underlyingName)
          ? await executeTrashRewrite(decision.rewrite, callAbort.signal, undefined, gate.assertPath)
          : await registered.execute(executeArgs, {
        workspacePath: session.workspacePath,
        ...(gate.assertPath ? { assertPath: gate.assertPath } : {}),
        ...(gate.cocoShell ? { cocoShell: gate.cocoShell } : {}),
        ...(gate.cocoMcpCall ? { cocoMcpCall: gate.cocoMcpCall } : {}),
        ...(gate.cocoProjectPath ? { cocoProjectPath: gate.cocoProjectPath } : {}),
        sessionId: session.id,
        workspaceId: session.workspaceId,
        fullPermissionsEnabled: progressGate.fullPermissionsEnabled,
        headlessMode: gate.headless === true,
        ...(subagentId ? { subagentTurn: true } : {}),
        toolCallId: call.id,
        signal: callAbort.signal,
        emitLive: (kind, payload) => {
          emit(onEvent, { type: "tool_live", toolCallId: call.id, kind, payload });
        },
        enableFullPermissions: () => progressGate.enableFullPermissions(),
        requestUserAsk: (askInput) => {
          const callIndex = toolCalls.findIndex((item) => item.id === call.id);
          const remainingToolCallIds =
            callIndex >= 0
              ? toolCalls.slice(callIndex + 1).map((item) => item.id)
              : [];
          return progressGate.requestUserAsk({
            ...askInput,
            toolCallId: call.id,
            assistantMessageId,
            remainingToolCallIds,
          });
        },
        ...(bridgeScope ? { bridgeScope } : {}),
        ...(resetModelIterations ? { resetModelIterations } : {}),
        ...(getVisionClient ? { getVisionClient } : {}),
        ...(getImageGenClient ? { getImageGenClient } : {}),
        ...(uploadImageGenInput ? { uploadImageGenInput } : {}),
        ...(uploadReadImage ? { uploadReadImage } : {}),
        ...(subagents ? { subagents } : {}),
        ...(listAgentSessions ? { listAgentSessions } : {}),
        ...(listSessionHistory ? { listSessionHistory } : {}),
        ...(listWorkspaces ? { listWorkspaces } : {}),
        ...(fsmGraphLibrary ? { fsmGraphLibrary } : {}),
        ...(turnHandoff ? { turnHandoff } : {}),
        ...(loops ? { loops } : {}),
        ...(notify ? { notify } : {}),
        planSnapshot: batchExtra.planSnapshot ?? null,
        planDocSnapshot: batchExtra.planDocSnapshot ?? null,
        ...(typeof batchExtra.requirePlanDocForCreatePlan === "boolean"
          ? { requirePlanDocForCreatePlan: batchExtra.requirePlanDocForCreatePlan }
          : {}),
        ...(typeof batchExtra.requirePlanDocApprovalForCreatePlan === "boolean"
          ? { requirePlanDocApprovalForCreatePlan: batchExtra.requirePlanDocApprovalForCreatePlan }
          : {}),
        ...(typeof batchExtra.planExecutionRequested === "boolean"
          ? { planExecutionRequested: batchExtra.planExecutionRequested }
          : {}),
        ...(Array.isArray(batchExtra.boundRouteEvents)
          ? { boundRouteEvents: batchExtra.boundRouteEvents.filter((event): event is string => typeof event === "string") }
          : {}),
        ...(batchExtra.shellStructuredReceipt === true ? { shellStructuredReceipt: true } : {}),
        ...(typeof batchExtra.skillActor === "string"
          ? { skillActor: batchExtra.skillActor as SkillActor }
          : {}),
        ...(batchExtra.skillWritePolicy === "auto_owned_only"
          ? { skillWritePolicy: "auto_owned_only" as const }
          : {}),
      });
      // A returned result is authoritative even if cancellation arrived during
      // the operation. Preserve it before sealing only the unexecuted siblings.
      executedResult = result;

      if (
        result.returnCode === ToolReturnCode.Success &&
        result.sessionPatch &&
        input.applySessionPatch
      ) {
        input.applySessionPatch(result.sessionPatch);
        if ("plan" in result.sessionPatch) {
          batchExtra.planSnapshot = session.plan ?? null;
        }
        if ("planDoc" in result.sessionPatch) {
          batchExtra.planDocSnapshot = session.planDoc ?? null;
        }
      }

      if (
        result.returnCode === ToolReturnCode.Success &&
        result.routeEvent &&
        typeof result.routeEvent.event === "string" &&
        result.routeEvent.event.trim()
      ) {
        routeEvents.push({
          event: result.routeEvent.event.trim(),
          ...(result.routeEvent.source
            ? { source: result.routeEvent.source }
            : {}),
        });
      }

      const success = result.returnCode === ToolReturnCode.Success;
      if (success) emitToolFileWrite({ tool: effectiveCall.name, args: executeArgs, sessionId: session.id, workspacePath: session.workspacePath });
      const cancelled = result.returnCode === ToolReturnCode.Cancelled;
      let content = result.content;
      // Per-tool abort (the run_shell stop button): tell the model the user
      // stopped this call on purpose. turn-level abort is handled above.
      if (cancelled && callAbort.signal.aborted) {
        content = interruptSignal?.aborted
          ? deniedContent("Interrupted by user message — execution stopped; apply the latest user prompt before retrying. Side effects already performed may remain.")
          : cancelledByUserContent(underlyingName);
      }
      let postHook: MergedHookResult | null = null;
      if (hooks && !signal?.aborted) {
        postHook = await runPostToolHooks({
          hooks,
          session,
          call: effectiveCall,
          args: executeArgs,
          result,
          success,
        });
        content = applyOutputRewrite(content, postHook.updatedMcpToolOutput);
        content = appendAdditionalContext(content, postHook.additionalContext);
        // Also append any leftover pre-hook context
        if (preHook?.additionalContext) {
          content = appendAdditionalContext(content, preHook.additionalContext);
        }
      }
      timelineResultRaw = safeTimelineJson(content);
      timelineReturnCode = result.returnCode;

      setToolCallStatus(
        call,
        cancelled ? "cancelled" : success ? "done" : "error",
      );
      await appendToolMessage(
        session,
        createId,
        call.id,
        content,
        result.returnCode,
        summaryForToolResult(registered, effectiveCall, content, result.returnCode),
      );
      receipts.push({
        toolCallId: call.id,
        name: underlyingName,
        returnCode: result.returnCode,
        ...(result.receipt ? { receipt: result.receipt } : {}),
      });
      const logFields = {
        sessionId: session.id,
        toolCallId: call.id,
        name: underlyingName,
        ...(resolved.viaBridge ? { viaBridge: true, bridgeName: call.name } : {}),
        returnCode: result.returnCode,
        durationMs: Date.now() - startedAt,
        resultPreview: previewToolContent(content),
      };
      if (cancelled) {
        agentLogWarn("tool.cancelled", {
          sessionId: session.id,
          toolCallId: call.id,
          name: underlyingName,
          reason: "abort_tool_call",
          returnCode: result.returnCode,
          durationMs: Date.now() - startedAt,
        });
        recordStats(input, effectiveCall, startedAt, {
          status: "cancelled",
          reason: "abort_tool_call",
          returnCode: result.returnCode,
          scene: failureSceneFromCall(effectiveCall, {
            resultText: previewToolContent(content),
            errorMessage: "Tool aborted by user",
          }),
        });
      } else if (success) {
        agentLogInfo("tool.result", logFields);
        recordStats(input, effectiveCall, startedAt, {
          status: "success",
          reason: "ok",
          returnCode: result.returnCode,
        });
      } else {
        timelineError = previewToolContent(content);
        agentLogWarn("tool.result", logFields);
        recordStats(input, effectiveCall, startedAt, {
          status: "tool_error",
          reason: "handler",
          returnCode: result.returnCode,
          scene: failureSceneFromCall(effectiveCall, {
            resultText: previewToolContent(content),
            errorMessage: previewToolContent(content),
          }),
        });
      }
      emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
      if (signal?.aborted) return cancelBatch("abort_after_execute");
    } catch (err) {
      // A recorded result remains authoritative if saving it failed. Do not
      // rewrite it as a handler failure or accidentally retry the operation.
      if (err instanceof ToolCheckpointError) throw err;
      if (executedResult) {
        // Session patches, post hooks, summaries and UI callbacks are local
        // processing. Their failures cannot change the handler's actual result.
        if (!scopedResults().has(call.id)) {
          const result = executedResult;
          setToolCallStatus(call, result.returnCode === ToolReturnCode.Success ? "done"
            : result.returnCode === ToolReturnCode.Cancelled ? "cancelled" : "error");
          // Do not call the optional summarizer again: it may be the failing
          // post-processing step. The original result must still be recorded.
          await appendToolMessage(session, createId, call.id, result.content, result.returnCode);
          emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
        }
        timelineReturnCode = executedResult.returnCode;
        if (!signal?.aborted) {
          const detail = err instanceof Error ? err.message : String(err);
          const message = `Tool returned a result, but post-processing failed: ${detail}. The original result was preserved; the tool was not retried.`;
          timelineError = message;
          agentLogError("tool.result_processing_failed", {
            sessionId: session.id, assistantMessageId, toolCallId: call.id,
            name: underlyingName, message,
          });
          emit(onEvent, { type: "error", message });
          return { cancelled: false, toolFailureCount: failureCount(), routeEvents,
            processingError: message };
        }
      }
      if (signal?.aborted) {
        // Without a returned result, retain running so sealing records unknown.
        agentLogWarn("tool.cancelled", {
          sessionId: session.id,
          toolCallId: call.id,
          name: underlyingName,
          reason: "abort_on_exception",
        });
        recordStats(input, effectiveCall, startedAt, {
          status: "cancelled",
          reason: "abort_on_exception",
          scene: failureSceneFromCall(effectiveCall, {
            errorMessage: "Aborted on exception path",
          }),
        });
        return cancelBatch("abort_on_exception");
      }
      if (callAbort.signal.aborted) {
        const content = deniedContent(
          interruptSignal?.aborted
            ? "Interrupted by user message — execution stopped; side effects already performed may remain."
            : "Tool call stopped by user",
        );
        timelineReturnCode = ToolReturnCode.Cancelled;
        timelineResultRaw = safeTimelineJson(content);
        setToolCallStatus(call, "cancelled");
        await appendToolMessage(session, createId, call.id, content, ToolReturnCode.Cancelled,
          summaryForToolResult(registered, effectiveCall, content, ToolReturnCode.Cancelled));
        emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      timelineError = message;
      timelineReturnCode = ToolReturnCode.GenericFailure;
      let content = deniedContent(message);
      if (hooks) {
        const postHook = await runPostToolHooks({
          hooks,
          session,
          call: effectiveCall,
          args: executeArgs,
          result: {
            content,
            returnCode: ToolReturnCode.GenericFailure,
          },
          success: false,
          errorMessage: message,
        });
        content = appendAdditionalContext(content, postHook.additionalContext);
        if (preHook?.additionalContext) {
          content = appendAdditionalContext(content, preHook.additionalContext);
        }
      }
      timelineResultRaw = safeTimelineJson(content);
      setToolCallStatus(call, "error");
      await appendToolMessage(
        session,
        createId,
        call.id,
        content,
        ToolReturnCode.GenericFailure,
        summaryForToolResult(
          registered,
          effectiveCall,
          content,
          ToolReturnCode.GenericFailure,
        ),
      );
      agentLogError("tool.error", {
        sessionId: session.id,
        toolCallId: call.id,
        name: underlyingName,
        reason: "exception",
        message,
        returnCode: ToolReturnCode.GenericFailure,
        durationMs: Date.now() - startedAt,
        ...(err instanceof Error && err.stack
          ? { stack: truncateForLog(err.stack, 4_000) }
          : {}),
      });
      recordStats(input, effectiveCall, startedAt, {
        status: "exception",
        reason: "exception",
        returnCode: ToolReturnCode.GenericFailure,
        scene: failureSceneFromCall(effectiveCall, {
          errorMessage: message,
          resultText: message,
        }),
      });
      emitToolFinished(onEvent, session, call.id, underlyingName, assistantMessageId);
    } finally {
      unregisterToolCallAbort(call.id);
      signal?.removeEventListener("abort", onTurnAbort);
      interruptSignal?.removeEventListener("abort", onInterruptAbort);
      timelineTool?.finish({
        status:
          call.status === "done"
            ? "success"
            : call.status === "running"
              ? "error"
              : call.status,
        ...(timelineReturnCode !== undefined
          ? { returnCode: timelineReturnCode }
          : {}),
        ...(timelineError !== undefined ? { error: timelineError } : {}),
        ...(timelineResultRaw !== undefined
          ? { resultRaw: timelineResultRaw }
          : {}),
      });
    }
    } catch (error) {
      if (!(error instanceof ToolCheckpointError)) throw error;
      if (error.stage === "before_execution") {
        setToolCallStatus(call, "error");
        const content = deniedContent(error.message);
        appendToolMessageToSession(session, createId, call.id, content,
          ToolReturnCode.GenericFailure,
          summaryForToolResult(getTool(call.name), call, content, ToolReturnCode.GenericFailure),
          assistantMessageId);
      }
      agentLogError("tool.checkpoint_failed", {
        sessionId: session.id, assistantMessageId, toolCallId: call.id,
        stage: error.stage, message: error.message,
      });
      emit(onEvent, { type: "error", message: error.message });
      emitToolFinished(onEvent, session, call.id, call.name, assistantMessageId);
      return { cancelled: false, toolFailureCount: failureCount(), routeEvents,
        persistenceError: error.message };
    }
  }

  if (signal?.aborted) return cancelBatch("abort_after_batch");
  if (interruptSignal?.aborted) return interruptBatch();

  return {
    cancelled: false,
    toolFailureCount: failureCount(),
    routeEvents,
    receipts,
  };
}
