export type {
  AwaitSubagentEntry,
  DispatchSubagentInput,
  DispatchSubagentResult,
  GetBatchResultOutcome,
  StopSubagentEntry,
  SubagentBatchEntry,
  SubagentBatchResult,
  SubagentDetailSnapshot,
  SubagentHost,
  SubagentRole,
  SubagentRun,
  SubagentRunStatus,
  SubagentStatusSnapshot,
  SubagentTranscriptMessage,
} from "./types.js";
export {
  bridgeScopeForSubagent,

} from "./toolFilter.js";
export type {
  SubagentResultAttachment,
  SubagentResultPayload,
  SubagentResultTable,
} from "./summary.js";
export {
  createSubagentManager,
  getSubagentManager,
  SubagentManager,
} from "./manager.js";
export type { CreateSubagentManagerInput } from "./manager.js";
export {
  injectSubagentBatchResults,

} from "./injectBatchResults.js";
