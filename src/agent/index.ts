/**
 * Agent turn orchestration — OpenAI-compatible streaming + tool loop.
 */

export { runAgentTurn } from "./runAgentTurn.js";
export type {
  TurnHost,
  TurnRunResult,
  TurnHostCounters,
  PrepareToolsInput,
  PrepareToolsResult,
  PrepareModelWindowInput,
  PrepareModelWindowResult,
  ModelRoundResult,
  ToolsPhaseResult,
  AwaitSubagentResult,
} from "./turnHost/index.js";
export type {
  TurnWorkflow,
  WorkflowRunResult,
} from "./workflow/index.js";
export type {
  CompactionStrategyId,
  ContextCompactionStrategy,
  CompactBeforeIterationInput,
  CompactContextResult,
  CompactionBuildConfig,
} from "./contextCompaction/types.js";
export type {
  RoleKind,
  RoleLlmBinding,
  RoleLlmBundle,
  OrchestratorMode,
  TurnState,
} from "./roles/index.js";
export {
  createUniformRoleLlmBundle,
  createRoleLlmBinding,

} from "./roles/index.js";
export type {
  SubagentHost,
  SubagentDetailSnapshot,
  SubagentRole,
  SubagentRunStatus,
  SubagentStatusSnapshot,
} from "./subagents/index.js";
export type {
  EnvironmentContextInput,
  EnvironmentLocaleSnapshot,
  EnvironmentWorkspaceSnapshot,
} from "./environmentContext.js";
export type {
  RequestTokenEstimate,
  DecisionTokens,
  DecisionTokenSource,
} from "./estimateTokens.js";
export {
  type ConversationTurn,
  type ModelIteration,
} from "./contextCompaction/conversationTurns.js";
export type {
  AgentStreamPayload,
  SessionSummary,
  StartTurnRequest,
  StartTurnResponse,
  ToolApprovalDismissPayload,
  ToolApprovalRequestPayload,
  ToolApprovalResponseRequest,
  UserAskDismissPayload,
  UserAskRequestPayload,
  UserAskResponseRequest,
} from "./ipcTypes.js";
