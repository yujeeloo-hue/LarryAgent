import { ToolReturnCode } from "../../session/returnCodes.js";
import { HEADLESS_ASK_CANCELLED_TEXT } from "../../session/headlessAsk.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

/** Fixed choice labels — matched after the user answers. */
export const REQUEST_FULL_PERMISSIONS_ENABLE = "Enable";
export const REQUEST_FULL_PERMISSIONS_DENY = "Deny";

const DEFAULT_QUESTION =
  "Bypass permissions are required to continue (write files, run shell, manage skills/MCP, and similar). Enable them for the rest of this turn?";

/** Default level: 0 — the interactive card is the gate. */
export const requestFullPermissionsDefinition: ToolDefinition = {
  name: "request_full_permissions",
  description:
    "Ask the user to enable Bypass permissions for the rest of this turn (level-1 tools).",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Short explanation shown on the prompt card.",
      },
    },
  },
  defaultPermissionLevel: 0,
};

function buildQuestion(reason: string): string {
  if (!reason) return DEFAULT_QUESTION;
  return `${reason.trim()}\n\nEnable Bypass permissions for the rest of this turn?`;
}

export const requestFullPermissionsHandler: ToolHandler = async (
  args,
  context,
) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (context.fullPermissionsEnabled) {
    return textResult(
      "Bypass permissions are already enabled for this turn.",
      ToolReturnCode.Success,
    );
  }

  if (!context.requestUserAsk) {
    return failureResult(
      "request_full_permissions is not available in this runtime.",
      ToolReturnCode.GenericFailure,
    );
  }

  if (!context.enableFullPermissions) {
    return failureResult(
      "Cannot enable Bypass permissions in this runtime.",
      ToolReturnCode.GenericFailure,
    );
  }

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  const answer = await context.requestUserAsk({
    question: buildQuestion(reason),
    options: [
      REQUEST_FULL_PERMISSIONS_ENABLE,
      REQUEST_FULL_PERMISSIONS_DENY,
    ],
    allowCustom: false,
  });

  const abortedAfter = abortIfSignaled(context.signal);
  if (abortedAfter) return abortedAfter;

  if (!answer) {
    return failureResult(
      context.headlessMode === true
        ? `${HEADLESS_ASK_CANCELLED_TEXT} Bypass permissions were not enabled.`
        : "User did not enable Bypass permissions (cancelled).",
      ToolReturnCode.Cancelled,
    );
  }

  if (answer.selected === REQUEST_FULL_PERMISSIONS_DENY) {
    return failureResult(
      "User denied Bypass permissions.",
      ToolReturnCode.Cancelled,
    );
  }

  if (answer.selected !== REQUEST_FULL_PERMISSIONS_ENABLE) {
    return failureResult(
      "User did not enable Bypass permissions.",
      ToolReturnCode.Cancelled,
    );
  }

  context.enableFullPermissions();
  return textResult(
    "Bypass permissions enabled for the rest of this turn. Retry the tools that need them.",
    ToolReturnCode.Success,
  );
};
