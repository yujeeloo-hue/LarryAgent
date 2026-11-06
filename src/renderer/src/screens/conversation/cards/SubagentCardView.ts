import type { SubagentStatusKind } from "./ToolInvocationCardView.js";

/** Live subagent status keyed by parent dispatch tool_call id. */
export type SubagentCardSnapshot = {
  id: string;
  parentToolCallId: string;
  title: string;
  status: SubagentStatusKind;
  progressText?: string;
  summary?: string;
  errorMessage?: string;
  role?: string;
  /** Child context window used tokens (live). */
  usedTokens?: number;
};
