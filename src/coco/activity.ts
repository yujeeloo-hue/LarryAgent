import type { CocoSnapshot } from "./types.js";

export type CocoActivity = { running: boolean; workRunning: boolean; chatRunning: boolean };
export type CocoActivityInput = Pick<CocoSnapshot, "state" | "activeJob" | "chatJob" | "planningJob" | "executionJob" | "work"> & {
  chat?: Pick<NonNullable<CocoSnapshot["chat"]>, "status" | "question" | "approval"> | undefined;
};

export const IDLE_COCO_ACTIVITY: CocoActivity = { running: false, workRunning: false, chatRunning: false };

/** Drives the shell's CoCo icon motion; computed in main and pushed on change. */
export function cocoActivity(snapshot: CocoActivityInput): CocoActivity {
  const active = !["paused", "blocked", "stopping"].includes(snapshot.state);
  const job = snapshot.activeJob?.status === "running" ? snapshot.activeJob : undefined;
  const chatRunning = !["blocked","stopping"].includes(snapshot.state) && !snapshot.chat?.question && !snapshot.chat?.approval
    && (snapshot.chat ? snapshot.chat.status === "running" : snapshot.chatJob?.status === "running" || job?.kind === "chat");
  // Execution can continue in its own session while the commander handles chat.
  const workRunning = active && (Boolean(snapshot.planningJob?.status === "running" || snapshot.executionJob?.status === "running" || (job && job.kind !== "chat"))
    || (snapshot.state === "working" && snapshot.work.some(work => !work.waitingForSession && (work.status === "executing" || work.status === "verifying"))));
  return { running: chatRunning || workRunning, workRunning, chatRunning };
}

export function sameCocoActivity(a: CocoActivity, b: CocoActivity): boolean {
  return a.running === b.running && a.workRunning === b.workRunning && a.chatRunning === b.chatRunning;
}
