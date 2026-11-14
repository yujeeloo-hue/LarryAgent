/**
 * notify — surface a desktop notification to the user.
 *
 * Routes through the self-owned notification hub (main/appNotify.ts):
 * foreground = in-app toast, background = corner popup (macOS below the
 * menu bar / Windows above the taskbar). Clicking any surface jumps back
 * to this session. No system Notification is involved.
 *
 * Message center is opt-in: by default the notification is transient (it
 * shows, then it is gone). `inbox: true` additionally files it unread in
 * the title-bar bell inbox until clicked — task completion is the only
 * caller that does this automatically.
 *
 * Use for: milestone reached mid-task, long-running progress pings, or an
 * attention nudge that should not block the turn (ask_user remains the
 * blocking question path). Keep it rare — one notification per distinct
 * event.
 */
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import type { NotifyToolInput } from "../notifyTool.js";

/** Copy guards — notification cards clamp to two body lines anyway. */
const TITLE_MAX = 120;
const BODY_MAX = 300;

export const notifyDefinition: ToolDefinition = {
  name: "notify",
  description:
    "Show the user a desktop notification — an in-app toast when the app is focused, a corner popup (macOS: below the menu bar; Windows: above the taskbar) when it is in the background. Transient by default: nothing is filed in the title-bar bell inbox. Pass inbox: true to also keep it there unread until clicked. Clicking the notification jumps back to this session. Use for milestone or progress pings during long turns, or an attention nudge that should NOT block the turn (ask_user is the blocking question path). Keep it rare: one notification per distinct event.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: 'Short headline (<=120 chars), e.g. "Deploy finished".',
      },
      body: {
        type: "string",
        description:
          'One-two line detail shown under the title, e.g. "2 files changed · 38s". Optional.',
      },
      inbox: {
        type: "boolean",
        description:
          "Also file this notification in the bell inbox (message center), unread until clicked. Default false — the toast/popup shows and is then gone. Reserve true for results the user must be able to find later.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

/** Level-1 gate note when the port is absent. */
const PORT_MISSING =
  "Notifications are not available in this host (no notify port). The desktop notification hub is main-process only.";

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const notifyHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const port = context.notify;
  if (!port) return failureResult(PORT_MISSING, ToolReturnCode.GenericFailure);

  const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
  if (!rawTitle) {
    return failureResult(
      '"title" is required (non-empty string).',
      ToolReturnCode.InvalidArguments,
    );
  }
  const rawBody = typeof args.body === "string" ? args.body.trim() : "";
  // Opt-in message center: absent/false stays transient (hub default).
  const inbox = typeof args.inbox === "boolean" ? args.inbox : false;

  const input: NotifyToolInput = {
    title: clamp(rawTitle, TITLE_MAX),
    body: clamp(rawBody, BODY_MAX),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(inbox ? { inbox: true } : {}),
  };
  port(input);
  const shown = input.body
    ? `"${input.title}" — ${input.body}`
    : `"${input.title}"`;
  const fate = inbox
    ? "filed unread in the bell inbox until clicked — clicking opens this session"
    : "transient — not filed in the bell inbox";
  return textResult(
    `Notification delivered: ${shown} (toast if the app is focused, corner popup otherwise; ${fate}).`,
    ToolReturnCode.Success,
  );
};
