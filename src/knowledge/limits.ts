export const KNOWLEDGE_BODY_MAX_CHARS = 32_000;
export const KNOWLEDGE_TITLE_MAX_CHARS = 120;
export const KNOWLEDGE_SUMMARY_MAX_CHARS = 200;
export const KNOWLEDGE_KEYWORDS_MIN = 3;
export const KNOWLEDGE_KEYWORDS_MAX = 20;
export const KNOWLEDGE_KEYWORD_MAX_CHARS = 40;
export const KNOWLEDGE_CATEGORY_DESCRIPTION_MAX_CHARS = 300;
export const KNOWLEDGE_PATCH_EDITS_MAX = 16;
export const KNOWLEDGE_CATALOG_MAX_CHARS = 1_500;
export const KNOWLEDGE_SEARCH_RESULT_MAX_CHARS = 8_000;
export const KNOWLEDGE_READ_MAX_CHARS = 128_000;
export const KNOWLEDGE_FRESHNESS_INTERVAL_MS = 500;

export const KNOWLEDGE_CATEGORY_FILE = "_category.md";

const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export function isValidKnowledgeCategory(value: string): boolean {
  return CATEGORY_RE.test(value);
}

export function isValidKnowledgeSlug(value: string): boolean {
  return SLUG_RE.test(value) && value !== "_category";
}

export function splitKnowledgeId(id: string): { category: string; slug: string } | null {
  const trimmed = id.trim().replace(/\.md$/i, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [category, slug] = parts as [string, string];
  if (!isValidKnowledgeCategory(category) || !isValidKnowledgeSlug(slug)) return null;
  return { category, slug };
}

export function slugFromTitle(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return ascii || "doc";
}
