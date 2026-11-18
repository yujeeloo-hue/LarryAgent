import type { JsonObject, ToolResultContentPart } from "../session/types.js";

export type HookEventName =
  | "beforeSubmitPrompt"
  | "turnStart"
  | "preCompact"
  | "preToolUse"
  | "beforeShellExecution"
  | "beforeMCPExecution"
  | "beforeReadFile"
  | "postToolUse"
  | "postToolUseFailure"
  | "afterShellExecution"
  | "afterMCPExecution"
  | "afterFileEdit"
  | "stop"
  | "turnEnd";

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  "beforeSubmitPrompt",
  "turnStart",
  "preCompact",
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "postToolUse",
  "postToolUseFailure",
  "afterShellExecution",
  "afterMCPExecution",
  "afterFileEdit",
  "stop",
  "turnEnd",
] as const;

export type HookPermission = "allow" | "deny" | "ask";

export type HookDecision = {
  permission?: HookPermission;
  updated_input?: JsonObject;
  updated_prompt?: string;
  additional_context?: string;
  updated_mcp_tool_output?: ToolResultContentPart[] | string;
  user_message?: string;
  agent_message?: string;
};

export type HookSource = "user" | "project" | "in-process";

export type HookCommandConfig = {
  command: string;
  type?: "command";
  timeout?: number;
  matcher?: string;
  failClosed?: boolean;
};

export type HooksFileConfig = {
  version: number;
  hooks: Partial<Record<HookEventName, HookCommandConfig[]>>;
};

export type HookBasePayload = {
  sessionId: string;
  workspacePath: string;
  cwd: string;
};

export type HookPayload = HookBasePayload & Record<string, unknown>;

export type InProcessHookHandler = (
  event: HookEventName,
  payload: HookPayload,
) => Promise<HookDecision | void> | HookDecision | void;

export type InProcessHookRegistration = {
  id: string;
  event: HookEventName;
  handler: InProcessHookHandler;
  matcher?: string;
  failClosed?: boolean;
};

export type MergedHookResult = {
  permission: HookPermission;
  updatedInput?: JsonObject;
  updatedPrompt?: string;
  additionalContext?: string;
  updatedMcpToolOutput?: ToolResultContentPart[] | string;
  userMessage?: string;
  agentMessage?: string;
  denied: boolean;
};

export type HookListEntry = {
  id: string;
  event: HookEventName;
  source: HookSource;
  command: string;
  matcher?: string;
  failClosed: boolean;
  timeoutSec?: number;
};

export type HookRunnerOptions = {
  userDataRoot: string;
  workspacePath: string;
  signal?: AbortSignal;
};

export type HookRunner = {
  run(
    event: HookEventName,
    payload: Omit<HookPayload, keyof HookBasePayload> &
      Partial<HookBasePayload>,
  ): Promise<MergedHookResult>;
  listEntries(): HookListEntry[];
  reload(): Promise<void>;
  paths(): { user: string; project: string };
};
