import { KNOWLEDGE_CATALOG_MAX_CHARS } from "./limits.js";
import { knowledgeBase } from "./store.js";
import type { KnowledgeCategory, KnowledgeDoc } from "./types.js";

export const KNOWLEDGE_CATALOG_HEADER =
  "[Knowledge base — built-in reference docs for complex capabilities. Before using one of these areas, read_knowledge({ id }) the matching doc; search_knowledge finds docs by keyword. Fix outdated docs with patch_knowledge]";

export function buildKnowledgeCatalogNote(
  categories: readonly KnowledgeCategory[] = knowledgeBase.listCategories(),
  docs: readonly KnowledgeDoc[] = knowledgeBase.listDocs(),
): string | null {
  if (docs.length === 0) return null;
  const lines = [KNOWLEDGE_CATALOG_HEADER];
  let size = KNOWLEDGE_CATALOG_HEADER.length;
  let listed = 0;
  let truncated = false;
  for (const category of categories) {
    const members = docs.filter((doc) => doc.category === category.id);
    if (members.length === 0) continue;
    const header = `${category.id}:`;
    if (size + header.length + 1 > KNOWLEDGE_CATALOG_MAX_CHARS) {
      truncated = true;
      break;
    }
    lines.push(header);
    size += header.length + 1;
    for (const doc of members) {
      const line = `- ${doc.id}: ${doc.title}${doc.stale ? " [stale]" : ""}`;
      if (size + line.length + 1 > KNOWLEDGE_CATALOG_MAX_CHARS) {
        truncated = true;
        break;
      }
      lines.push(line);
      size += line.length + 1;
      listed += 1;
    }
    if (truncated) break;
  }
  const rest = docs.length - listed;
  if (rest > 0) lines.push(`- … ${rest} more — use search_knowledge.`);
  return lines.join("\n");
}
