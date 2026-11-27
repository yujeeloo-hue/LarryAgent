import { randomUUID } from "node:crypto";
import type { JsonObject } from "../session/types.js";
import type { StreamChatFn, SummarizeFn } from "../agent/types.js";

export type CocoExecutionAccess = {
  role?: "commander" | "background";
  seedMessages?: import("../session/types.js").Message[];
  extraSystemPrompt?: string;
  wireTrailingNote?: string;
  conversationTurnLimit?: number;
  conversationTurnStartIds?(): ReadonlySet<string>;
  persona?(): import("../agent/turnHost/buildSystemPrefix.js").PersonaOverride;
  compaction?(): { compactTriggerRatio?: number | undefined; iterationProtectTokenRatio?: number | undefined };
  additionalTools?: import("../tools/types.js").RegisteredTool[];
  toolPredicate?(name: string): boolean;
  onSessionClaim?(sessionId: string): void;
  onPromptInsert?(prompts: ReadonlyArray<{ cocoWorkId?: string }>): void;
  workspaceId: string;
  canStartTurn(): boolean;
  allowWorkspace?(workspaceId: string): boolean;
  signal: AbortSignal;
  stream: StreamChatFn;
  summarize: SummarizeFn;
  assertTool(name: string, args: JsonObject): void;
  assertPath(path: string): void;
  ask?(input: { question: string; options: string[]; allowCustom: boolean; allowMultiple?: boolean }): Promise<import("../tools/types.js").UserAskAnswer | null>;
  confirm?(input: { toolName: string; arguments: JsonObject; risk?: import("../tools/types.js").ToolApprovalRisk; source?: import("../tools/types.js").ToolConfirmationSource }): Promise<boolean>;
  beforeToolExecute(name: string, args: JsonObject): void;
  cocoShell?: import("../tools/types.js").ToolExecuteContext["cocoShell"];
  cocoMcpCall?: import("../tools/types.js").ToolExecuteContext["cocoMcpCall"];
  cocoProjectPath?(workspaceId: string): string;
};
const executions = new Map<string, CocoExecutionAccess>();
export function registerCocoExecution(access: CocoExecutionAccess): { id: string; release(): void } {
  const id = randomUUID(); executions.set(id, access);
  return { id, release: () => executions.delete(id) };
}
export function getCocoExecution(id?: string): CocoExecutionAccess | undefined { return id ? executions.get(id) : undefined; }

export function cocoSourceForAccess(access: CocoExecutionAccess | undefined): "coco" | "coco_chat" | "coco_internal" | undefined {
  if (!access) return undefined;
  if (access.role === "commander") return "coco_chat";
  if (access.role === "background") return "coco_internal";
  return "coco";
}
