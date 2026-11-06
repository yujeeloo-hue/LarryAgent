import type { DemoCardState, DemoSettled, DemoSubmitReceipt } from "../../../../../session/demoCardState.js";
import type { PlanProgressDisplay } from "../planSnapshots.js";
import type { UploadLiveState } from "./uploadCard.js";

/** Live countdown seed for a running sleep-detected run_shell card. */
export type SleepLiveState = {
  /** Card creation timestamp (≈ command start); drives the RAF countdown. */
  startedAt: number;
  /** Planned wait seconds from the command itself. */
  seconds: number;
  /** Whether non-sleep commands follow the wait. */
  hasFollowUp: boolean;
};

export type ToolResultSnapshot = {
  returnCode: number;
  content: Array<Record<string, unknown>>;
  /** One-line English template summary of the tool run (no LLM). */
  executionSummary?: string;
};

export type PendingAskSnapshot = {
  requestId: string;
  question: string;
  options: string[];
  optionDetails?: import("../../../../../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple: boolean;
};

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
  /** Skip the expensive body entirely for older history cards. */
  initiallyCollapsed?: boolean;
  result?: ToolResultSnapshot;
  pendingAsk?: PendingAskSnapshot;
  /**
   * Live write_file body while arguments are still streaming (or pending
   * execution). Shown instead of the “Waiting…” placeholder.
   */
  previewContent?: string;
  /** Pre-resolved update_plan / complete_plan one-liner + status kind. */
  planProgress?: PlanProgressDisplay;
  /** Live subagent run status for dispatch_subagent compact card. */
  subagentStatus?: SubagentStatusKind;
  /** Child context used tokens for dispatch_subagent compact card. */
  subagentUsedTokens?: number;
  /** Subagent run id → LLM nickname for await/stop/status card titles. */
  subagentNamesById?: Map<string, string>;
  onUserAskAnswer?: (
    requestId: string,
    answer: { selected: string; selections?: string[]; custom: boolean; comment?: string },
  ) => void;
  /** Abort one running tool call (run_shell stop button). */
  onAbortToolCall?: (toolCallId: string) => void;
  /**
   * Live rsync-upload progress for a running run_shell card (tool_live
   * "upload" snapshots). Seeded from command detection when absent.
   */
  uploadLive?: UploadLiveState;
  /** Live countdown for a running sleep-detected run_shell card. */
  sleepLive?: SleepLiveState;
  /** present_demo: confirmed/queued params (settled scan) for this call. */
  demoSettled?: DemoSettled;
  /**
   * present_demo: Confirm → submit the chosen values as the next user
   * message (idle starts a turn; running enqueues).
   */
  demoStates?: Map<string, DemoCardState>;
  onSubmitDemoParams?: (
    values: Record<string, string | number | boolean | null>,
    note?: string,
  ) => void | Promise<void | DemoSubmitReceipt>;
};
