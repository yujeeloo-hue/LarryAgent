import type { Session } from "../../session/types.js";

export type SubagentRole = "general" | "explore" | "worker";

export type SubagentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export type SubagentRun = {
  id: string;
  parentSessionId: string;
  parentToolCallId: string;
  batchId: string;
  name: string;
  prompt: string;
  role: SubagentRole;
  priority: number;
  status: SubagentRunStatus;
  progressText: string;
  createdAt: number;
  updatedAt: number;
  abort: AbortController;
  session: Session;
  resultSummary?: string;
  errorMessage?: string;
  done: Promise<void>;
};

export type SubagentStatusSnapshot = {
  id: string;
  batchId: string;
  name: string;
  role: SubagentRole;
  priority: number;
  status: SubagentRunStatus;
  progressText: string;
  parentToolCallId: string;
  summary?: string;
  errorMessage?: string;
};

export type SubagentTranscript = {
  run: SubagentStatusSnapshot & { createdAt: number; updatedAt: number };
  messages: Session["messages"];
};

export type SubagentRunSummary = SubagentStatusSnapshot & {
  createdAt: number;
  updatedAt: number;
};

export type SubagentTranscriptMessage = {
  role: string;
  text: string;
};

export type SubagentDetailSnapshot = SubagentStatusSnapshot & {
  prompt: string;
  messages: SubagentTranscriptMessage[];
};

export type DispatchSubagentInput = {
  prompt: string;
  batchId: string;
  name?: string;
  role?: SubagentRole;
  priority?: number;
  parentToolCallId: string;
};

export type DispatchSubagentResult =
  | {
      ok: true;
      id: string;
      name: string;
      batchId: string;
      priority: number;
      status: "queued" | "running";
    }
  | {
      ok: false;
      message: string;
      returnCode: number;
    };

export type AwaitSubagentEntry = {
  id: string;
  name: string;
  priority: number;
  status: SubagentRunStatus;
  summary?: string;
  errorMessage?: string;
};

export type StopSubagentEntry = {
  id: string;
  name: string;
  status: SubagentRunStatus;
  stopped: boolean;
  message: string;
};

export type SubagentBatchEntry = {
  id: string;
  name: string;
  priority: number;
  status: SubagentRunStatus;
  summary?: string;
  errorMessage?: string;
};

export type SubagentBatchResult = {
  batchId: string;
  entries: SubagentBatchEntry[];
};

export type GetBatchResultOutcome =
  | { ok: true; result: SubagentBatchResult }
  | { ok: false; message: string; returnCode: number };

export type SubagentHost = {
  dispatch: (input: DispatchSubagentInput) => DispatchSubagentResult;
  awaitRuns: (
    ids: string[],
    timeoutMs?: number,
  ) => Promise<AwaitSubagentEntry[]>;
  getBatchResult: (
    batchId: string,
    timeoutMs?: number,
  ) => Promise<GetBatchResultOutcome>;
  getStatus: (ids?: string[]) => SubagentStatusSnapshot[];
  list: (includeFinished?: boolean) => SubagentStatusSnapshot[];
  stop: (ids: string[]) => StopSubagentEntry[];
  stopAll: () => void;
  getDetail: (id: string) => SubagentDetailSnapshot | null;
  sealOpenBatches: () => void;
  hasIncompleteBatches: () => boolean;
  waitForIncompleteBatches: (signal?: AbortSignal) => Promise<void>;
  drainInbox: () => SubagentBatchResult[];
};
