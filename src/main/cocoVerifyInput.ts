import { sessionDialogue } from "./cocoDecide.js";
import type { CocoWork, CocoWorkResult } from "../coco/types.js";
import type { Message } from "../session/types.js";

/** The same task text the execution session already received: goal, steps, and acceptance descriptions. */
export function taskBrief(work: Pick<CocoWork, "objective" | "steps" | "acceptance">): string {
  const steps = work.steps.map(step => step.trim()).filter(Boolean);
  const acceptance = work.acceptance.map(criterion => criterion.description.trim()).filter(Boolean);
  return [
    work.objective.trim(),
    ...(steps.length ? ["", "Steps:", ...steps] : []),
    ...(acceptance.length ? ["", "Acceptance criteria:", ...acceptance] : []),
  ].join("\n");
}

/** Plain-text review a person could read. Verification and unclassified recovery both use it. The model reply is the only JSON. */
export function buildVerifyInput(work: Pick<CocoWork, "objective" | "steps" | "acceptance">, messages: readonly Message[] | undefined, reports: readonly CocoWorkResult[] = []): string {
  const dialogue = sessionDialogue(messages ?? []);
  const lines = [taskBrief(work)];
  if (dialogue.summary) lines.push("", "Summary:", dialogue.summary);
  lines.push("", "Conversation:");
  if (!dialogue.dialogue.length) lines.push("No user or assistant text yet.");
  else for (const turn of dialogue.dialogue) lines.push("", turn.role === "user" ? "User:" : "Assistant:", turn.text);
  const delivered: CocoWorkResult[] = [], seen = new Set<string>();
  for (const report of [...reports].sort((a,b) => b.at - a.at || b.capturedAt - a.capturedAt)) {
    const key = report.path ?? report.title;
    if (report.source === "message" || seen.has(key)) continue;
    seen.add(key); delivered.push(report);
  }
  if (delivered.length) {
    lines.push("", "Saved task reports (actual delivered content, not verification):");
    for (const report of delivered) lines.push("", report.title, `Saved: ${new Date(report.at).toISOString()} · Revision ${report.revision}`, ...(report.path ? [`Source file: ${report.path}`] : []), report.markdown);
  }
  return lines.join("\n");
}
