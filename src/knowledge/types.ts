export type KnowledgeSource = "builtin" | "user" | "override";

export type KnowledgeLayer = "builtin" | "user";

export type KnowledgeSection = {
  heading: string;
  text: string;
};

export type KnowledgeDoc = {
  id: string;
  category: string;
  slug: string;
  title: string;
  summary: string;
  keywords: string[];
  relatedTools: string[];
  guideFor: string[];
  version: number;
  updatedAt: string;
  body: string;
  source: KnowledgeSource;
  stale: boolean;
  baseVersion?: number;
  builtinVersion?: number;
  filePath: string;
};

export type KnowledgeCategory = {
  id: string;
  title: string;
  description: string;
  layer: KnowledgeLayer;
  docCount: number;
};

export type KnowledgeSearchHit = {
  doc: KnowledgeDoc;
  score: number;
};

export type KnowledgeSearchResult = {
  hits: KnowledgeSearchHit[];
  mode: "and" | "or" | "list";
};

export type KnowledgeWriteInput = {
  id?: string;
  category: string;
  slug?: string;
  title: string;
  summary: string;
  keywords: string[];
  content: string;
  relatedTools?: string[];
  guideFor?: string[];
  categoryDescription?: string;
};

export type KnowledgePatchInput = {
  id: string;
  edits: Array<{ oldString: string; newString: string }>;
  summary?: string;
  keywords?: string[];
};

export type KnowledgeMutationResult =
  | { ok: true; doc: KnowledgeDoc; created: boolean }
  | { ok: false; code: "invalid" | "not_found" | "denied"; message: string };

export type KnowledgeDeleteResult =
  | { ok: true; id: string; reverted: boolean }
  | { ok: false; code: "not_found" | "denied" | "invalid"; message: string };

export type KnowledgeDocSummary = {
  id: string;
  category: string;
  title: string;
  summary: string;
  keywords: string[];
  source: KnowledgeSource;
  stale: boolean;
  version: number;
  updatedAt: string;
};

export type KnowledgeListSnapshot = {
  categories: Array<{ id: string; title: string; description: string; docs: KnowledgeDocSummary[] }>;
};
