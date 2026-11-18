import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  ChatResponseFormat,
  OpenAiChatMessage,
  OpenAiCompatibleClientConfig,
} from "../../llm/types.js";
import type { JsonObject } from "../../session/types.js";
import type { Session } from "../../session/types.js";
import type { PermissionGateState } from "../../tools/types.js";
import type { StreamChatFn } from "../types.js";
import type { PlanFacade } from "./PlanFacade.js";

export type RoleKind = string;

export const BUILTIN_ROLE_KINDS = [
  "agent",
  "analyser",
  "planner",
  "plan_writer",
  "plan_reviewer",
  "executor",
  "replanner",
  "subagent",
] as const;

export type BuiltinRoleKind = (typeof BUILTIN_ROLE_KINDS)[number];

export type PendingPlanDraft = {
  title: string;
  steps: string[];
};

export type TurnState = {
  activeRole: RoleKind;
  planAttempts: number;
  planWriterAttempts: number;
  replanCount: number;
  lastBlockReason?: string;
  maxPlanAttempts: number;
  maxPlanWriterAttempts: number;
  maxReplansPerTurn: number;
  allowPlannerExecutorOverride: boolean;
  pendingPlanDraft?: PendingPlanDraft;
};

export type CreateTurnStateInput = {
  activeRole?: RoleKind;
  maxPlanAttempts?: number;
  maxPlanWriterAttempts?: number;
  maxReplansPerTurn?: number;
  allowPlannerExecutorOverride?: boolean;
};

export function createTurnState(
  input: CreateTurnStateInput = {},
): TurnState {
  return {
    activeRole: input.activeRole ?? "agent",
    planAttempts: 0,
    planWriterAttempts: 0,
    replanCount: 0,
    maxPlanAttempts: input.maxPlanAttempts ?? 2,
    maxPlanWriterAttempts: input.maxPlanWriterAttempts ?? 2,
    maxReplansPerTurn: input.maxReplansPerTurn ?? 3,
    allowPlannerExecutorOverride: input.allowPlannerExecutorOverride !== false,
  };
}

export type RoleLlmCompleteInput = {
  purpose: string;
  messages: OpenAiChatMessage[];
  responseFormat?: ChatResponseFormat;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
};

export type RoleLlmBinding = {
  providerId: string;
  model: string;
  client: OpenAiCompatibleClientConfig;
  hostedTools: () => readonly JsonObject[];
  messagesForBinding: (
    messages: readonly OpenAiChatMessage[],
    builtScope?: string,
  ) => OpenAiChatMessage[];
  stream: StreamChatFn;
  complete: (input: RoleLlmCompleteInput) => Promise<string>;
};

export type RoleLlmBundle = {
  sessionDefault: RoleLlmBinding;
  agent: RoleLlmBinding;
  planner: RoleLlmBinding;
  planWriter: RoleLlmBinding;
  executor: RoleLlmBinding;
  replanner: RoleLlmBinding;
  subagent: RoleLlmBinding;
  byProviderId: Record<string, RoleLlmBinding>;
};

export type RoleIterationSpec = {
  roleKind: RoleKind;
  roleSystemPrompt: string;
  personaLabel: string;
  promptPlacement?: "persona" | "system" | "overlay";
  phaseOverlay?: string;
  systemInject?: string;
  toolPredicate?: (name: string) => boolean;
  includeSkills: boolean;
};

export type RoleIterationOutcome =
  | { type: "yield_to_host" }
  | { type: "stay" }
  | {
      type: "hand_off";
      to: RoleKind;
      reason?: string;
      llmProviderId?: string;
    }
  | { type: "failed"; message: string }
  | { type: "done" };

export type RoleContext = {
  state: TurnState;
  session: Session;
  signal?: AbortSignal;
  gate: PermissionGateState;
  plan: PlanFacade;
  createId: () => string;
  onEvent?: (event: StreamEvent) => void;
  resolveProviderBinding?: (providerId: string) => RoleLlmBinding | null;
  resetTurnBudgetsAfterPlanProgress?: (reason: string) => void;
};

export type OrchestratorMode = "react" | "ask" | "plan_execute" | "subagent";
