import {
  loadUserMemory,
} from "../../memory/store.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 0 (always allowed). */
export const readUserMemoryDefinition: ToolDefinition = {
  name: "read_user_memory",
  description: "Read the durable app-global user profile.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  defaultPermissionLevel: 0,
};

export const readUserMemoryHandler: ToolHandler = async (_args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const snap = await loadUserMemory();
  if (snap.empty) {
    return textResult(
      "User memory is empty. No durable profile has been saved yet.",
      ToolReturnCode.Success,
    );
  }

  const updated =
    snap.updatedAt > 0
      ? `\n\n(updatedAt: ${new Date(snap.updatedAt).toISOString()})`
      : "";
  return textResult(
    `# User profile\n\n${snap.profile.trim()}${updated}`,
    ToolReturnCode.Success,
  );
};
