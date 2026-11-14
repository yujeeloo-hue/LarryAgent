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

/** Built-in role ids used by stock graphs / prompts. Custom strings are allowed. */
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

/**
 * Turn-scoped mutable state. Owned by workflow turnScope, shared via `RoleContext.state`.
 * Durable transcript / plan / status stay on `Session`.
 */
export type TurnState = {
  /** Current active role kind (graph routing). */
  activeRole: RoleKind;
  planAttempts: number;
  planWriterAttempts: number;
  replanCount: number;
  lastBlockReason?: string;
  maxPlanAttempts: number;
  maxPlanWriterAttempts: number;
  maxReplansPerTurn: number;
  allowPlannerExecutorOverride: boolean;
  /**
   * Side-path `route=plan` themes held while plan_writer writes docs/plans/.
   * Not an executable Session.plan. Cleared after write_plan_doc or discard.
   */
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
  /** UI status while this non-stream call is in flight (retries included). */
  onProgress?: (text: string) => void;
};

/** Orchestrator-injected binding; Role holds this. Host uses active.llm. */
export type RoleLlmBinding = {
  providerId: string;
  model: string;
  /** Underlying wire config (apiKey not logged). */
  client: OpenAiCompatibleClientConfig;
  /** Provider-owned tools, exposed without protocol selection in graph actions. */
  hostedTools: () => readonly JsonObject[];
  /** Remove replay/reasoning fields that do not belong to this binding. */
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
  /** All resolved providers for hand_off overrides (providerId → binding). */
  byProviderId: Record<string, RoleLlmBinding>;
};

export type RoleIterationSpec = {
  roleKind: RoleKind;
  roleSystemPrompt: string;
  personaLabel: string;
  /** Explicit prompt channel; defaults to system for hand-built specs. */
  promptPlacement?: "persona" | "system" | "overlay";
  phaseOverlay?: string;
  /**
   * PromptInject(placement=system) blocks for Bucket0 (extra system after
   * AGENT / plan-role markdown). Wire-only; not persisted / not shown in UI.
   */
  systemInject?: string;
  /** Legacy domain helper output; FSM tool policies belong to PrepareTools. */
  toolPredicate?: (name: string) => boolean;
  /**
   * Unused for Bucket0 — skills are discovered via search_skills → read_skill.
   * Kept for FSM params / logs.
   */
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

/** Runtime bag for prepare/routing helpers + Host deps. */
export type RoleContext = {
  state: TurnState;
  session: Session;
  signal?: AbortSignal;
  gate: PermissionGateState;
  plan: PlanFacade;
  createId: () => string;
  onEvent?: (event: StreamEvent) => void;
  resolveProviderBinding?: (providerId: string) => RoleLlmBinding | null;
  /** Optional: reset iteration/token budgets after plan progress. */
  resetTurnBudgetsAfterPlanProgress?: (reason: string) => void;
};

export type OrchestratorMode = "react" | "ask" | "plan_execute" | "subagent";
