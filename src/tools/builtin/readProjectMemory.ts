import { loadProjectMemory } from "../../projectMemory/store.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import { projectMemoryWorkspace } from "../projectMemoryTarget.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 0 (always allowed). */
export const readProjectMemoryDefinition: ToolDefinition = {
  name: "read_project_memory",
  description:
    "Read the durable PROJECT.md for the current workspace (five sections; the Recent section mirrors docs/WORKLOG.md, PITFALLS.md, HANDOFF.md — read_file those for detail, plus docs/STYLE.md and docs/DEPLOY.md).",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  defaultPermissionLevel: 0,
};

export const readProjectMemoryHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const workspacePath = projectMemoryWorkspace(args, context);
  if (typeof workspacePath !== "string") return workspacePath;

  const snap = await loadProjectMemory(workspacePath);
  if (snap.empty) {
    return textResult(
      "Project memory is empty. No PROJECT.md has been saved yet for this workspace.",
      ToolReturnCode.Success,
    );
  }

  const updated =
    snap.updatedAt > 0
      ? `\n\n(updatedAt: ${new Date(snap.updatedAt).toISOString()})`
      : "";
  return textResult(
    `# PROJECT.md\n\nPath: ${snap.filePath}\n\n${snap.body.trim()}${updated}`,
    ToolReturnCode.Success,
  );
};
