import { knowledgeBase } from "./store.js";
import type { KnowledgeDoc } from "./types.js";

export function knowledgeGuidePointer(doc: Pick<KnowledgeDoc, "id">): string {
  return `Guide: read_knowledge("${doc.id}")`;
}

export function describeWithKnowledgeGuide(
  description: string,
  guide: Pick<KnowledgeDoc, "id"> | null | undefined,
): string {
  if (!guide) return description;
  const pointer = knowledgeGuidePointer(guide);
  const base = description.trimEnd();
  if (!base) return pointer;
  return `${base}${/[.!?。]$/.test(base) ? "" : "."} ${pointer}.`;
}

export function knowledgeGuideFor(toolName: string): KnowledgeDoc | null {
  if (!knowledgeBase.isConfigured()) return null;
  return knowledgeBase.guideFor(toolName);
}

export function knowledgeGuideRevisionText(toolName: string, description: string): string {
  const guide = knowledgeGuideFor(toolName);
  return guide ? `${description}\n\n[knowledge:${guide.id}]\n${guide.body}` : description;
}
