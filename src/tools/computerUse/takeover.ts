import type { ToolExecuteContext } from "../types.js";
import { tipsOverlay, type TipsOverlay } from "./cursorOverlay.js";
import { runHandoff, userHasPointer, type HandoffResult } from "./handoff.js";
import type { ComputerUseService } from "./service.js";

export const TAKEOVER_TITLE = "Paused — you have the mouse";

export type TakeoverDeps = {
  tips?: TipsOverlay;
  now?: () => number;
};

type TakeoverService = Pick<ComputerUseService, "inputActivity" | "coversJellyBot">;

export async function awaitPointerTakeover(
  svc: TakeoverService,
  context: Pick<ToolExecuteContext, "subagentTurn" | "requestUserAsk" | "signal">,
  deps: TakeoverDeps = {},
): Promise<HandoffResult | null> {
  if (context.subagentTurn) return null;
  const activity = await svc.inputActivity();
  if (!activity) return null;
  const now = deps.now ?? Date.now;
  if (!userHasPointer(activity, now(), { overJellyBot: svc.coversJellyBot(activity.cursor) })) return null;
  return runHandoff(
    { kind: "takeover", title: TAKEOVER_TITLE, message: "", spotlight: false },
    {
      tips: deps.tips ?? tipsOverlay(),
      ...(context.requestUserAsk ? { ask: context.requestUserAsk } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      now,
    },
  );
}
