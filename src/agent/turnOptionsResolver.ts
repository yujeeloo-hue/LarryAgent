import type { ComposerRunMode } from "./ipcTypes.js";

export function composerRunModeFromRequest(req: {
  runMode?: ComposerRunMode;
  planMode?: boolean;
}): ComposerRunMode {
  if (
    req.runMode === "agent" ||
    req.runMode === "ask" ||
    req.runMode === "plan" ||
    req.runMode === "custom"
  ) {
    return req.runMode;
  }
  return req.planMode === true ? "plan" : "agent";
}
