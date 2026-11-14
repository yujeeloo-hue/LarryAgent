import {
  writeUserMemoryProfile,
} from "../../memory/store.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 0 (always allowed). */
export const updateUserMemoryDefinition: ToolDefinition = {
  name: "update_user_memory",
  description:
    "Update the durable user profile (merge or replace). Cross-project preferences only — project-specific style/conventions belong in the workspace PROJECT.md.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Markdown to store (full profile when mode=replace).",
      },
      mode: {
        type: "string",
        enum: ["merge", "replace"],
        description: "merge (default) appends; replace overwrites.",
      },
    },
    required: ["content"],
  },
  defaultPermissionLevel: 0,
};

export const updateUserMemoryHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) {
    return failureResult(
      'Invalid arguments: "content" must be a non-empty string.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const modeRaw = typeof args.mode === "string" ? args.mode.trim() : "merge";
  const mode = modeRaw === "replace" ? "replace" : "merge";

  const snap = await writeUserMemoryProfile(content, mode);
  const chars = snap.profile.length;
  return textResult(
    `User memory updated (${mode}). Profile now ${chars} characters.`,
    ToolReturnCode.Success,
  );
};
