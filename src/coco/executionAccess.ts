import { randomUUID } from "node:crypto";
import type { JsonObject } from "../session/types.js";
import type { StreamChatFn, SummarizeFn } from "../agent/types.js";

/** Process-local capabilities. IPC callers cannot manufacture these tokens. */
export type CocoExecutionAccess = {
  role?: "commander" | "background";
  seedMessages?: import("../session/types.js").Message[];
  extraSystemPrompt?: string;
  /** Commander only: wire-only trailing user note for automatic turns that have no user message. */
  wireTrailingNote?: string;
  /** Commander only: model window keeps only the newest N Chat turns. */
  conversationTurnLimit?: number;
  /** Commander only: first message ids of prompt-less Chat turns (automatic / hand-over). */
  conversationTurnStartIds?(): ReadonlySet<string>;
  /** Commander only: CoCo's own SOUL / AGENT / COCO_MEMORY, re-read every model iteration. */
  persona?(): import("../agent/turnHost/buildSystemPrefix.js").PersonaOverride;
  /** Commander only: per-CoCo Chat compaction overrides; re-read per use so saved settings apply on the next turn. */
  compaction?(): { compactTriggerRatio?: number | undefined; iterationProtectTokenRatio?: number | undefined };
  additionalTools?: import("../tools/types.js").RegisteredTool[];
  toolPredicate?(name: string): boolean;
  onSessionClaim?(sessionId: string): void;
  /** Commander only: carry selected work context into a mid-turn user insert. */
  onPromptInsert?(prompts: ReadonlyArray<{ cocoWorkId?: string }>): void;
  workspaceId: string;
  canStartTurn(): boolean;
  allowWorkspace?(workspaceId: string): boolean;
  signal: AbortSignal;
  stream: StreamChatFn;
  summarize: SummarizeFn;
  assertTool(name: string, args: JsonObject): void;
  assertPath(path: string): void;
  /** Omitted on non-commander roles → questions resolve to null (no answer). */
  ask?(input: { question: string; options: string[]; allowCustom: boolean; allowMultiple?: boolean }): Promise<import("../tools/types.js").UserAskAnswer | null>;
  /** Omitted on non-commander roles → approvals are denied. */
  confirm?(input: { toolName: string; arguments: JsonObject; risk?: import("../tools/types.js").ToolApprovalRisk; source?: import("../tools/types.js").ToolConfirmationSource }): Promise<boolean>;
  beforeToolExecute(name: string, args: JsonObject): void;
  cocoShell?: import("../tools/types.js").ToolExecuteContext["cocoShell"];
  cocoMcpCall?: import("../tools/types.js").ToolExecuteContext["cocoMcpCall"];
  /** Commander only: project memory tools may target another in-scope project. */
  cocoProjectPath?(workspaceId: string): string;
};
const executions = new Map<string, CocoExecutionAccess>();
export function registerCocoExecution(access: CocoExecutionAccess): { id: string; release(): void } {
  const id = randomUUID(); executions.set(id, access);
  return { id, release: () => executions.delete(id) };
}
export function getCocoExecution(id?: string): CocoExecutionAccess | undefined { return id ? executions.get(id) : undefined; }

/**
 * Origin marker implied by a trusted CoCo execution access: execution lanes
 * (no role) own 'coco' work sessions; commander/background map to their
 * internal-only markers. undefined when the turn is not CoCo-owned — the
 * single source of truth for sidebar origin badges, so callers forgetting the
 * explicit `source` request field can no longer lose the marker.
 */
export function cocoSourceForAccess(access: CocoExecutionAccess | undefined): "coco" | "coco_chat" | "coco_internal" | undefined {
  if (!access) return undefined;
  if (access.role === "commander") return "coco_chat";
  if (access.role === "background") return "coco_internal";
  return "coco";
}
