import { IDLE_COCO_ACTIVITY, type CocoActivity } from "../../../coco/activity.js";
import { cocoIconMotionClock } from "../ui/cocoIconMotion.js";

export function renderCocoActivity(activity: CocoActivity | undefined): void {
  const { running, workRunning, chatRunning } = activity ?? IDLE_COCO_ACTIVITY;
  const root = document.documentElement;
  const flags = { global: running, work: workRunning, chat: chatRunning };
  cocoIconMotionClock.setRunning(flags);
  Object.assign(root.dataset, {
    cocoRunning: String(running),
    cocoWorkRunning: String(workRunning),
    cocoChatRunning: String(chatRunning),
  });
}
