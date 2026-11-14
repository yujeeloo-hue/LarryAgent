import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { NodeActionStubBase, boolParam, numberParam, stringParam } from "./NodeActionStubBase.js";

/** Default gate: only notify for turns that ran ≥ 10 minutes. */
export const DEFAULT_TASK_DONE_MIN_ELAPSED_MS = 600_000;

export const NodeActionNotifyTaskDoneSchema: FsmParamsSchema = {
  type: "object",
  title: "Notify task done",
  description:
    "Desktop notification for long parent turns. Optional confetti when the app is foreground.",
  "x-llmDescription": "End-node desktop notification for long parent turns: minElapsedMs (default 600000), celebrate (confetti when foreground), title, body. Pure no-op without the Host capability.",
  details: `End-node desktop notification for long parent turns. Fires host.desktopNotify only when: this turn ran at least minElapsedMs of wall time (measured from StartTurn's turnStartedAtMs) and the turn actually started (control-intent terminal entries skip). The default title is "Task finished"; default body is "<session title> · 12m / 1h 05m". Optional title / body params override those defaults.

Presentation: the notification always shows — in-app toast when the app is foreground, corner popup when background; when celebrate is on and the app is foreground, in-app confetti plays on top of the toast. Pure no-op without the injected desktopNotify capability — safe to hang on any graph's End node. Ask / subagent graphs omit this Action at the graph level, not inside the Action.`,
  additionalProperties: false,
  properties: {
    minElapsedMs: {
      type: "integer",
      default: DEFAULT_TASK_DONE_MIN_ELAPSED_MS,
      minimum: 0,
      title: "Min elapsed (milliseconds)",
      description:
        "Notify only when the turn has run at least this many milliseconds (1 second = 1000; 1 minute = 60000). Default 600000 = 10 minutes.",
      "x-ui": "number",
    },
    celebrate: {
      type: "boolean",
      default: false,
      title: "Celebrate (confetti)",
      description:
        "When the app is in the foreground at completion, rain confetti on top of the system notification (which always shows, any focus state).",
      "x-ui": "toggle",
    },
    title: {
      type: "string",
      title: "Title",
      description: 'Notification title. Default: "Task finished".',
      "x-ui": "text",
    },
    body: {
      type: "string",
      title: "Body",
      description:
        "Notification body. Default: session title plus elapsed time.",
      "x-ui": "text",
    },
  },
};

/** `12m` / `1h 05m`-style compact duration for notification bodies. */
function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * End-of-turn desktop notification for long-running background tasks
 * (self-owned toast / corner popup, never a system notification).
 *
 * Fires `host.desktopNotify` when this turn finished after ≥
 * `minElapsedMs` of wall time. Pure no-op without a Host (stub path) or
 * without the injected desktopNotify capability.
 */
export class NodeActionNotifyTaskDone extends NodeActionStubBase {
  readonly type = "NodeActionNotifyTaskDone";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const host = args.host;
    if (!host || !host.desktopNotify) {
      return { status: "continue" };
    }
    const startedAtMs = args.turnContext.turnStartedAtMs;
    if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) {
      return { status: "continue" };
    }

    const minElapsedMs = numberParam(
      this.params,
      "minElapsedMs",
      DEFAULT_TASK_DONE_MIN_ELAPSED_MS,
    );
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs < minElapsedMs) {
      return { status: "continue" };
    }

    const sessionTitle = host.session.title.trim() || "New task";
    const title =
      stringParam(this.params, "title")?.trim() || "Task finished";
    const body =
      stringParam(this.params, "body")?.trim() ||
      `${sessionTitle} · ${formatElapsed(elapsedMs)}`;
    host.desktopNotify({
      title,
      body,
      sessionId: host.session.id,
      celebrate: boolParam(this.params, "celebrate", false),
    });
    return {
      status: "continue",
      turnContextPatch: { taskDoneNotified: true },
    };
  }
}
