import type { Cadence } from "../loops/schedule.js";
import type { JsonObject } from "../session/types.js";
import type { CocoDecisionPrompt } from "./decisionPrompt.js";
export type { CocoDecisionPrompt } from "./decisionPrompt.js";

export type CocoToolApproval = { id: string; workId: string; revision: number; scope: string; toolName: string; arguments: JsonObject; reason: string; at: number; status: "pending" | "approved" | "denied" | "consumed" };

export type CocoScope = { all: boolean; workspaceIds: string[]; excludedWorkspaceIds: string[] };
export type CocoSettings = {
  enabled: boolean;
  providerId: string;
  /** Optional faster model for supervisory decisions and acceptance checks; empty = `providerId`. */
  fastProviderId?: string | undefined;
  hourlyTokens: number;
  dailyTokens: number;
  timezone: string;
  excludedWorkspaceIds: string[];
  fullPermissions: boolean;
  /** Autonomous heartbeat interval, 1–240 minutes. */
  heartbeatMinutes: number;
  repairLimit: number;
  reportTime: string;
  historyRetentionDays: number;
  /** Optional per-CoCo Chat compaction trigger override; undefined = follow the global Agent settings. */
  compactTriggerRatio?: number | undefined;
  /** Optional per-CoCo Chat protect/keep ratio override; undefined = follow the global Agent settings. */
  iterationProtectTokenRatio?: number | undefined;
};
export type CocoWorkStatus = "draft" | "queued" | "executing" | "recovering" | "verifying" | "waiting" | "to_decide" | "completed" | "cancelled";
export type CocoTimelineEntry = { at: number; text: string; status?: CocoWorkStatus; revision?: number };
/** Immutable task output, independent of the mutable project file and session retention. */
export type CocoWorkResult = {
  id: string; workId: string; revision: number; attemptId?: string; sessionId?: string;
  at: number; capturedAt: number; title: string; markdown: string;
  source: "report" | "file" | "message"; path?: string; messageId?: string; imported?: boolean;
};
/** Acceptance text describes what done looks like. Older records may still carry file or command fields; verification does not check them. */
export type CocoCriterion = { id: string; description: string; kind: "review" | "file_exists" | "file_contains" | "command_succeeded"; path?: string | undefined; text?: string | undefined; command?: string | undefined };
export type CocoWork = {
  recoveryAttempts?: number; recoverAt?: number | undefined;
  recovery?: { reason: string; turnId?: string | undefined; uncertainEffects?: boolean | undefined } | undefined;
  /** Soft-paused for automation token cooldown; auto-resumes when the budget window resets. */
  budgetHold?: boolean | undefined;
  resumeSession?: boolean; goalIds?: string[]; sessionStrategy?: "continue" | "steer" | "append" | undefined;
  /** Short user message for the next execution turn. Consumed when that turn starts. */
  advancePrompt?: string | undefined;
  /** The next To decide answer is sent as the next session prompt, not appended to the goal. */
  advanceOnAnswer?: boolean | undefined;
  prioritySource?: "user" | "coco" | undefined; deadlineAt?: number | undefined;
  runMode?: "agent" | "plan" | "ask" | undefined; reasoningEffort?: "off" | "low" | "medium" | "high" | "max" | undefined;
  id: string; goalId: string; title: string; objective: string; workspaceId: string;
  status: CocoWorkStatus; priority: number; dependsOn: string[]; steps: string[];
  acceptance: CocoCriterion[]; deliverables: string[]; ruleIds: string[];
  waitingForSession?: boolean | undefined; sessionId?: string | undefined; observeSessionId?: string | undefined; revision: number; repairs: number;
  /** Created by sidebar hand-over supervision; take-back cancels it. */
  handover?: boolean | undefined;
  fullPermissions: boolean; providerId: string; createdAt: number; updatedAt: number;
  summary: string; decision?: string | undefined; decisionPrompt?: CocoDecisionPrompt | undefined; timeline: CocoTimelineEntry[];
};
export type CocoRule = {
  origin?: "coco" | "user"; goalId?: string; draftOnly?: boolean;
  runMode?: "agent" | "plan" | "ask" | undefined; reasoningEffort?: "off" | "low" | "medium" | "high" | "max" | undefined;
  id: string; name: string; objective: string; mode: "fixed" | "inspection";
  scope: CocoScope; enabled: boolean; confirmed: boolean; cadence: Cadence;
  fullPermissions: boolean; providerId: string;
  acceptance: CocoCriterion[]; nextRunAt: number; createdAt: number;
  legacyId?: string | undefined; legacyConfig?: unknown;
};
/**
 * Wake ledger entry (kind "wakeEntry"): appended when something happens, read
 * by the heartbeat and event wakes, marked delivered after a successful
 * autonomous turn. Version changes are not entries; they are compared at wake time.
 */
export type CocoWakeEntry = {
  id: string; at: number;
  kind: "project_doc" | "work_status" | "workspace_added" | "workspace_removed" | "skill_library";
  workspaceId: string; workspaceName: string; workspacePath: string;
  /** skill_library: one-line curation result. */
  summary?: string | undefined;
  doc?: "PROJECT.md" | "WORKLOG.md" | undefined;
  workId?: string | undefined; workTitle?: string | undefined;
  outcome?: "completed" | "failed" | "interrupted" | undefined;
  reason?: "app_restart" | "retries_exhausted" | undefined;
  deliveredAt?: number | undefined;
};
/** Last delivered version of one project (meta `vcsBaseline`, keyed by workspace id). */
export type CocoVcsFact = { kind: "git"; ref: string; commit: string } | { kind: "svn"; revision: string };
/**
 * App-level MCP notification record (NotificationCenter → CoCo, kind "mcpEvent").
 * No workspace attribution and no rule triggering in v1 — CoCo response
 * semantics are deferred; context exposure is read-only ("see, don't act").
 */
export type CocoMcpEvent = { id: string; method: string; serverId: string; serverName: string; at: number };
export type CocoMessage = { origin?: "wake"; status?: "streaming" | "completed" | "stopped" | "error"; id: string; role: "user" | "assistant"; text: string; at: number; workId?: string | undefined; goalId?: string | undefined };
export type CocoLegacyRun = { id: string; ruleId: string; sessionId: string | null; status: string; startedAt: number; endedAt: number | null; error: string | null };
export type CocoHistoryPage = { runs: CocoLegacyRun[]; nextCursor?: { at: number; id: string } | undefined };
export type CocoVerification = { id: string; workId: string; revision: number; sessionId?: string | undefined; at: number; passed: boolean; summary: string; criteria?: CocoCriterion[]; objective?: string; evidenceDigest?: string; checks: { criterionId: string; passed: boolean; evidence: string }[] };
export type CocoAttempt = { id: string; workId: string; revision: number; resultRevision?: number; startedAt: number; endedAt?: number | undefined; sessionId?: string | undefined; status: "running" | "finished" | "interrupted" | "failed"; summary?: string | undefined };
export type CocoReport = { id: string; at: number; title: string; markdown: string; workIds: string[] };
/**
 * One scheduled/manual rule run (keyed by its job id; retries update the same record).
 * `source: "chat"` runs are derived at snapshot time from a chat request and its work; they are never stored and carry an empty `ruleId`.
 */
export type CocoRuleRun = { id: string; source?: "rule" | "chat" | undefined; ruleId: string; ruleName: string; startedAt: number; endedAt?: number | undefined; status: "running" | "retrying" | "no_action" | "planned" | "failed"; attempts: number; summary?: string | undefined; error?: string | undefined; retryAt?: number | undefined; workIds: string[] };
export type CocoJob = { wakeFingerprint?: string; id: string; kind: "chat" | "plan" | "execute" | "recover" | "cleanup" | "followup" | "decision" | "verify" | "inspect" | "report" | "greet" | "project" | "autonomous"; status: "queued" | "running" | "done"; at: number; priority: number; workId?: string | undefined; messageId?: string | undefined; ruleId?: string | undefined; input?: string | undefined; planOnly?: boolean | undefined; continuation?: "retry"; handoverInstruction?: string | undefined; planPrompt?: string; retryAt?: number; contextRetries?: number; retries?: number };
export type CocoUsage = { id: string; at: number; tokens: number; estimated: boolean; purpose: string; workId?: string | undefined };
export type CocoWorkChange = { workId: string; action: "pause" | "resume" | "cancel" | "priority" | "revise"; priority?: number | undefined; objective?: string | undefined; steps?: string[] | undefined; acceptance?: CocoCriterion[] | undefined; answer?: string | undefined };
export type CocoGoalPlan = { activateRuleIds?: string[]; changes?: CocoWorkChange[] | undefined; reply: string; planOnly: boolean; work: { key: string; title: string; objective: string; workspaceId: string; priority: number; deadlineAt?: number | undefined; userPriority?: boolean | undefined; dependsOn: string[]; steps: string[]; acceptance: CocoCriterion[]; deliverables: string[]; executionSessionId?: string; sessionStrategy?: "continue" | "steer" | "append" | undefined; observeSessionId?: string | undefined }[]; ruleSuggestions: Omit<CocoRule, "id" | "createdAt" | "confirmed" | "nextRunAt" | "legacyId" | "legacyConfig">[] };
export type CocoChatState = {
  textOnlyMessageIds?: string[];
  /** First message of each turn that has no user prompt (automatic / hand-over). */
  turnStartMessageIds?: string[];
  sessionId: string; status: string;
  /** `onBehalfOf` labels requests parked from a handed-over session (D-4). */
  question?: import("../agent/ipcTypes.js").UserAskRequestPayload & { onBehalfOf?: string };
  approval?: import("../agent/ipcTypes.js").ToolApprovalRequestPayload & { onBehalfOf?: string };
};
export type CocoChatControl =
  | { type: "chatControl"; action: "stop" }
  | { type: "chatControl"; action: "answer"; requestId: string; selected: string; selections?: string[]; custom: boolean }
  | { type: "chatControl"; action: "approval"; requestId: string; approved: boolean };
export type CocoBackgroundTask = {
  id: string; sessionId: string; purpose: string; title: string; workId?: string | undefined;
  status: "running" | "completed" | "error" | "interrupted";
  startedAt: number; updatedAt: number; progress: string; summary: string;
};
export type CocoSnapshot = {
  backgroundTasks?: CocoBackgroundTask[];
  activationSeen?: boolean;
  chat?: CocoChatState | undefined;
  settings: CocoSettings; state: "idle" | "working" | "paused" | "cooldown" | "blocked" | "stopping";
  pendingPlans?: { requestId: string; title: string; status: "queued" | "running" }[];
  chatJob?: CocoJob | undefined; planningJob?: CocoJob | undefined; executionJob?: CocoJob | undefined;
  /** Queued or running daily-report job; presence means a report is generating (Reports page button state). */
  reportJob?: CocoJob | undefined;
  /** Rules with a queued or running inspection job, manual or scheduled (Rules page "Run now" state). */
  runningRuleIds?: string[] | undefined;
  activeJob?: CocoJob | undefined; error?: string | undefined; resumeAt?: number | undefined;
  budget: { hourly: number; daily: number; estimated: boolean };
  work: CocoWork[]; rules: CocoRule[]; messages: CocoMessage[]; reports: CocoReport[];
  verifications: CocoVerification[]; attempts: CocoAttempt[];
  ruleRuns?: CocoRuleRun[];
  workspaces: { id: string; name: string }[];
  legacyRuns: CocoLegacyRun[];
  legacyCursors?: Record<string, { at: number; id: string } | undefined> | undefined;
  workspaceOptions?: { id: string; name: string }[] | undefined;
  toolApprovals?: CocoToolApproval[];
  mcpOptions?: { serverId: string; serverName: string; toolName: string; name: string; transport: "http" | "stdio" }[];
};
export type CocoCommand =
  | CocoChatControl
  | { type: "wake" }
  | { type: "activation"; action: "visit" | "enable" }
  | { type: "toolApproval"; id: string; action: "approve" | "deny" }
  | { type: "goal"; id: string; action: "start" | "cancel" }
  | { type: "chat"; text: string; workId?: string | undefined; workspaceId?: string | undefined; planOnly?: boolean | undefined; continuation?: "retry"; handoverInstruction?: string | undefined }
  | { type: "work"; id: string; action: "start" | "pause" | "resume" | "cancel" | "priority"; priority?: number | undefined; answer?: string | undefined }
  | { type: "rule"; action: "save"; rule: CocoRule }
  | { type: "rule"; action: "confirm" | "toggle" | "delete" | "run"; id: string }
  | { type: "settings"; settings: CocoSettings }
  | { type: "budget"; action: "reset" }
  | { type: "autonomousPrompt"; action: "reset" }
  | { type: "report" };
