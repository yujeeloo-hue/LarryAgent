import { isActiveWork, isTerminalWork } from "./status.js";
import type { CocoMessage, CocoRuleRun, CocoVerification, CocoWork } from "./types.js";

export type CocoRuleRunAcceptance = {
  workId: string;
  title: string;
  status: CocoWork["status"];
  tone: "passed" | "failed" | "pending" | "neutral";
  summary: string;
};

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const activeRun = (run: CocoRuleRun): boolean => run.status === "running" || run.status === "retrying";

/** Timeline anchor: rule runs sit at their trigger time; chat runs move to their completion once all of their work is finished. */
export const ruleRunAt = (run: CocoRuleRun): number => run.source === "chat" ? run.endedAt ?? run.startedAt : run.startedAt;

/** One run per chat request that planned work; it stays running while any of that work is queued or executing. */
export function chatRuns(work: CocoWork[], messages: CocoMessage[]): CocoRuleRun[] {
  const replies = new Map<string, CocoMessage>();
  for (const message of messages) if (message.role === "assistant" && message.goalId && message.text.trim() && message.status !== "error") replies.set(message.goalId, message);
  return messages.flatMap((request): CocoRuleRun[] => {
    if (request.role !== "user") return [];
    const planned = work.filter(w => (w.goalIds ?? [w.goalId]).includes(request.id));
    if (!planned.length) return [];
    const finished = planned.every(w => isTerminalWork(w.status));
    const running = planned.some(w => w.status === "queued" || isActiveWork(w.status));
    return [{
      id: `chat-${request.id}`, source: "chat", ruleId: "", ruleName: clip(request.text, 120) || planned[0]!.title,
      startedAt: request.at, ...(finished ? { endedAt: Math.max(...planned.map(w => w.updatedAt)) } : {}),
      status: running ? "running" : "planned", attempts: 1, summary: replies.get(request.id)?.text, workIds: planned.map(w => w.id),
    }];
  });
}

/** Newest runs first by timeline anchor; active runs are always kept beyond the limit. */
export function recentRuns(runs: CocoRuleRun[], limit: number): CocoRuleRun[] {
  return [...runs].sort((a, b) => ruleRunAt(b) - ruleRunAt(a)).filter((run, index) => index < limit || activeRun(run));
}

/** Acceptance overview for the work a rule run planned, using the latest verification of each work item. */
export function ruleRunAcceptance(run: CocoRuleRun, work: CocoWork[], verifications: CocoVerification[]): CocoRuleRunAcceptance[] {
  return run.workIds.flatMap((id): CocoRuleRunAcceptance[] => {
    const item = work.find(w => w.id === id);
    if (!item) return [];
    const latest = verifications.filter(v => v.workId === id).reduce<CocoVerification | undefined>((a, v) => !a || v.at >= a.at ? v : a, undefined);
    const base = { workId: id, title: item.title, status: item.status };
    if (item.status === "cancelled") return [{ ...base, tone: "neutral", summary: "Cancelled" }];
    if (item.status === "to_decide") return [{ ...base, tone: "failed", summary: clip(item.decision ?? item.summary, 160) || "Needs your decision" }];
    if (latest && (item.status === "completed" || latest.revision === item.revision)) {
      const passed = latest.checks.filter(c => c.passed).length, total = latest.checks.length;
      const failed = latest.checks.find(c => !c.passed);
      return [{ ...base, tone: latest.passed ? "passed" as const : "failed", summary: `${passed}/${total} criteria passed${failed ? ` · ${clip(failed.evidence, 140)}` : ""}` }];
    }
    return [{ ...base, tone: "pending", summary: `Acceptance pending · ${item.acceptance.length} ${item.acceptance.length === 1 ? "criterion" : "criteria"}` }];
  });
}
