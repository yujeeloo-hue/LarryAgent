import type { SubagentStatusKind } from "./ToolInvocationCardView.js";

export type SubagentCardSnapshot = {
  id: string;
  parentToolCallId: string;
  title: string;
  status: SubagentStatusKind;
  progressText?: string;
  summary?: string;
  errorMessage?: string;
  role?: string;
  usedTokens?: number;
};
