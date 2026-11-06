import type { CocoJob, CocoSnapshot } from "../../../../coco/types.js";

type RuntimeSnapshot = Pick<CocoSnapshot, "state" | "activeJob" | "planningJob" | "executionJob" | "chatJob" | "chat" | "pendingPlans" | "backgroundTasks" | "work">;

const JOB_LABELS: Record<CocoJob["kind"], string> = {
  chat: "CoCo is responding",
  greet: "CoCo is responding",
  plan: "CoCo is planning",
  execute: "CoCo is executing",
  recover: "CoCo is recovering",
  verify: "CoCo is verifying",
  inspect: "CoCo is inspecting",
  report: "CoCo is reporting",
  cleanup: "CoCo is summarizing",
  followup: "CoCo is updating",
  decision: "CoCo is reviewing",
  project: "CoCo is reading projects",
  autonomous: "CoCo is following up",
};
const CHECK_LABELS: Record<string, string> = { plan: JOB_LABELS.plan, recover: JOB_LABELS.recover, verify: JOB_LABELS.verify, inspect: JOB_LABELS.inspect, report: JOB_LABELS.report, retention: JOB_LABELS.cleanup, decide: JOB_LABELS.decision, project: JOB_LABELS.project };

/** Prefer the commander's current action while execution and conversation run alongside it. */
export function cocoRuntimeLabel(snapshot: RuntimeSnapshot): string {
  if (snapshot.state === "blocked") return "CoCo needs attention";
  if (snapshot.state === "stopping") return "CoCo is stopping";
  if (snapshot.state === "paused") return "Automatic work is paused";
  if (snapshot.state === "cooldown") return "Automatic work is cooling down";

  const job = [snapshot.planningJob, snapshot.activeJob, snapshot.executionJob]
    .find(job => job?.status === "running" && !["chat", "greet", "autonomous"].includes(job.kind));
  if (job) return JOB_LABELS[job.kind];
  if (snapshot.pendingPlans?.some(plan => plan.status === "running")) return JOB_LABELS.plan;
  const check = snapshot.backgroundTasks?.find(task => task.status === "running" && task.purpose !== "greet");
  if (check) return CHECK_LABELS[check.purpose] ?? "CoCo is checking";
  if (snapshot.state === "working") {
    const work = snapshot.work.find(work => !work.waitingForSession && !work.budgetHold && ["executing", "recovering", "verifying"].includes(work.status));
    if (work) return work.status === "verifying" ? JOB_LABELS.verify : work.status === "recovering" ? JOB_LABELS.recover : JOB_LABELS.execute;
  }

  if (snapshot.chat?.approval) return "Awaiting tool approval";
  if (snapshot.chat?.question) return "Awaiting your answer";
  const chatJob = snapshot.chatJob ?? snapshot.activeJob;
  if (chatJob?.status === "running" && chatJob.kind === "autonomous") return JOB_LABELS.autonomous;
  if (snapshot.chat ? snapshot.chat.status === "running" : chatJob?.status === "running" && ["chat", "greet"].includes(chatJob.kind)) return JOB_LABELS.chat;
  return snapshot.state === "working" ? "CoCo is preparing" : "Ready for your next goal";
}
