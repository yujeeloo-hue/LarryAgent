import type { DemoCardState, DemoSettled, DemoSubmitReceipt } from "../../../../../session/demoCardState.js";
import type { PlanProgressDisplay } from "../planSnapshots.js";
import type { UploadLiveState } from "./uploadCard.js";

export type SleepLiveState = {
  startedAt: number;
  seconds: number;
  hasFollowUp: boolean;
};

export type ToolResultSnapshot = {
  returnCode: number;
  content: Array<Record<string, unknown>>;
  executionSummary?: string;
};

export type PendingAskSnapshot = {
  requestId: string;
  question: string;
  detail?: string;
  options: string[];
  optionDetails?: import("../../../../../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple: boolean;
  passwordDestination?: import("../../../../../shared/askUser.js").HandoffPasswordDestination;
  handoffQrPng?: string;
};

export type SubmitHandoffPassword = (
  requestId: string, submission: import("../../../../../shared/askUser.js").HandoffPasswordSubmission,
) => Promise<import("../../../../../shared/askUser.js").HandoffPasswordStatus>;

export type SubagentStatusKind =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export type ToolInvocationCardInput = {
  id: string;
  name: string;
  status: string;
  arguments: unknown;
  argumentsRaw: string;
  initiallyCollapsed?: boolean;
  result?: ToolResultSnapshot;
  pendingAsk?: PendingAskSnapshot;
  onHandoffPassword?: SubmitHandoffPassword;
  previewContent?: string;
  planProgress?: PlanProgressDisplay;
  subagentStatus?: SubagentStatusKind;
  subagentUsedTokens?: number;
  subagentNamesById?: Map<string, string>;
  onUserAskAnswer?: (
    requestId: string,
    answer: { selected: string; selections?: string[]; custom: boolean; comment?: string },
  ) => void;
  onAbortToolCall?: (toolCallId: string) => void;
  uploadLive?: UploadLiveState;
  sleepLive?: SleepLiveState;
  demoSettled?: DemoSettled;
  demoStates?: Map<string, DemoCardState>;
  onSubmitDemoParams?: (
    values: Record<string, string | number | boolean | null>,
    note?: string,
  ) => void | Promise<void | DemoSubmitReceipt>;
};
