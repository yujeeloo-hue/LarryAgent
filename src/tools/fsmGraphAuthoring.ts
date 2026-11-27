export type FsmGraphToolFamily = "context" | "node" | "connection" | "action";
export type FsmGraphAuthoringOwner = {
  workspacePath: string;
  sessionId?: string;
};
export type FsmGraphAuthoringResult = {
  ok: boolean;
  error?: string;
  code?: string;
  [key: string]: unknown;
};
export type FsmGraphLibraryPort = {
  execute(family: FsmGraphToolFamily, input: Record<string, unknown>, owner: FsmGraphAuthoringOwner): Promise<FsmGraphAuthoringResult>;
};
export type FsmGraphRecordLike = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  origin: "user" | "llm";
  config: unknown;
};
