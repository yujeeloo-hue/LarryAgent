import { randomUUID } from "node:crypto";
import {
  getToolInvocation,
  insertToolInvocation,
  listToolInvocations,
  clearToolInvocations,
  summarizeToolInvocations,
  type ListToolInvocationsOptions,
  type SessionDatabase,
  type ToolInvocationRecord,
  type ToolInvocationSummaryRow,
} from "../session/db/index.js";
import type {
  RecordToolInvocationInput,
  ToolInvocationScene,
} from "./types.js";

const SCENE_ARGS_MAX = 32_000;
const SCENE_RESULT_MAX = 32_000;
const SCENE_RAW_MAX = 32_000;
const SCENE_MESSAGE_MAX = 4_000;

let db: SessionDatabase | null = null;
let enabled = true;

export function configureToolStats(options: {
  db: SessionDatabase;
  enabled?: boolean;
}): void {
  db = options.db;
  if (typeof options.enabled === "boolean") {
    enabled = options.enabled;
  }
}

export function setToolStatsEnabled(value: boolean): void {
  enabled = value === true;
}

export function isToolStatsEnabled(): boolean {
  return enabled;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

function cappedArguments(
  args: ToolInvocationScene["arguments"],
): ToolInvocationScene["arguments"] {
  if (args === undefined) return undefined;
  try {
    const raw = JSON.stringify(args);
    if (raw.length <= SCENE_ARGS_MAX) return args;
    return {
      _truncated: true,
      preview: truncate(raw, SCENE_ARGS_MAX),
    } as ToolInvocationScene["arguments"];
  } catch {
    return {
      _error: "unserializable_arguments",
    } as ToolInvocationScene["arguments"];
  }
}

function buildSceneJson(
  scene: ToolInvocationScene | undefined,
): string | undefined {
  if (!scene) return undefined;
  const out: Record<string, unknown> = {};
  const args = cappedArguments(scene.arguments);
  if (args !== undefined) out.arguments = args;
  if (typeof scene.argumentsRaw === "string") {
    out.argumentsRaw = truncate(scene.argumentsRaw, SCENE_RAW_MAX);
  }
  if (typeof scene.resultText === "string") {
    out.resultText = truncate(scene.resultText, SCENE_RESULT_MAX);
  }
  if (typeof scene.errorMessage === "string") {
    out.errorMessage = truncate(scene.errorMessage, SCENE_MESSAGE_MAX);
  }
  if (typeof scene.hookMessage === "string") {
    out.hookMessage = truncate(scene.hookMessage, SCENE_MESSAGE_MAX);
  }
  if (
    scene.permissionLevel === 0 ||
    scene.permissionLevel === 1 ||
    scene.permissionLevel === 2
  ) {
    out.permissionLevel = scene.permissionLevel;
  }
  try {
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({
      errorMessage: "Failed to serialize failure scene.",
    });
  }
}

/**
 * Persist one tool invocation for stats. Never throws into the agent turn.
 * Success rows omit scene_json; failures store a capped scene.
 */
export function recordToolInvocation(
  input: RecordToolInvocationInput & {
    isMcp: boolean;
    mcpServerId?: string;
  },
): void {
  if (!enabled || !db) return;
  try {
    const sceneJson =
      input.status === "success" ? undefined : buildSceneJson(input.scene);
    insertToolInvocation(db, {
      id: randomUUID(),
      sessionId: input.sessionId,
      ...(input.parentSessionId
        ? { parentSessionId: input.parentSessionId }
        : {}),
      ...(input.subagentId ? { subagentId: input.subagentId } : {}),
      toolCallId: input.toolCallId,
      name: input.name,
      isMcp: input.isMcp,
      ...(input.mcpServerId ? { mcpServerId: input.mcpServerId } : {}),
      status: input.status,
      reason: input.reason,
      ...(input.returnCode != null ? { returnCode: input.returnCode } : {}),
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      docRevision: input.docRevision ?? 0,
      ...(sceneJson !== undefined ? { sceneJson } : {}),
      createdAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tool-stats] record failed: ${message}`);
  }
}

export function getToolStatsSummary(options?: {
  sessionId?: string;
}): ToolInvocationSummaryRow[] {
  if (!db) return [];
  return summarizeToolInvocations(db, options ?? {});
}

export function listToolStatsInvocations(
  options?: ListToolInvocationsOptions,
): ToolInvocationRecord[] {
  if (!db) return [];
  return listToolInvocations(db, options);
}

export function getToolStatsInvocation(
  id: string,
): ToolInvocationRecord | null {
  if (!db) return null;
  return getToolInvocation(db, id);
}

/** Delete all recorded tool invocations; returns removed row count. */
export function resetToolStats(): number {
  if (!db) return 0;
  return clearToolInvocations(db);
}
