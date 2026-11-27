import type { KnowledgeDoc, KnowledgeSource } from "./types.js";

export type KnowledgeDocView = {
  id: string;
  category: string;
  title: string;
  summary: string;
  keywords: string[];
  guideFor: string[];
  source: KnowledgeSource;
  stale: boolean;
  version: number;
  builtinVersion?: number;
  updatedAt: string;
  body: string;
};

export function toKnowledgeDocView(doc: KnowledgeDoc): KnowledgeDocView {
  return {
    id: doc.id,
    category: doc.category,
    title: doc.title,
    summary: doc.summary,
    keywords: doc.keywords,
    guideFor: doc.guideFor,
    source: doc.source,
    stale: doc.stale,
    version: doc.version,
    ...(doc.builtinVersion !== undefined ? { builtinVersion: doc.builtinVersion } : {}),
    updatedAt: doc.updatedAt,
    body: doc.body,
  };
}
