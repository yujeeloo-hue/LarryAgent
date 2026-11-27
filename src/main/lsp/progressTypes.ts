export const LANGUAGE_SERVER_PROGRESS_CHANNEL = "languageServer:progress";

export type LanguageServerId = "lua" | "typescript";

type ProgressPhase =
  | { phase: "starting" }
  | { phase: "loading"; message?: string }
  | { phase: "diagnosing"; percent?: number }
  | { phase: "failed"; message: string }
  | { phase: "idle" };

export type LanguageServerProgressEvent = { server: LanguageServerId; rootPath: string } & ProgressPhase;
