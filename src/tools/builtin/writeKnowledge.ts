import { knowledgeBase } from "../../knowledge/store.js";
import { KNOWLEDGE_BODY_MAX_CHARS, KNOWLEDGE_SUMMARY_MAX_CHARS } from "../../knowledge/limits.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled } from "../pathUtil.js";
import {
  KNOWLEDGE_KEYWORDS_PROPERTY,
  KNOWLEDGE_REASON_PROPERTY,
  knowledgeMutationResult,
  knowledgeReason,
  knowledgeUnavailable,
  missingReasonResult,
  stringArg,
  stringListArg,
} from "./knowledgeArgs.js";

export const writeKnowledgeDefinition: ToolDefinition = {
  name: "write_knowledge",
  description: `Create or fully replace a knowledge-base doc (stored in the user layer; writing a built-in id creates an override that wins over it). Body is markdown sectioned by "##" headings, ≤${KNOWLEDGE_BODY_MAX_CHARS} chars. Record durable rules, protocols and pitfalls — not one-off task notes. For small fixes prefer patch_knowledge.`,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: 'Existing or new id "category/slug". Omit to build it from category + slug/title.' },
      category: { type: "string", description: "Category id (lowercase kebab-case)." },
      slug: { type: "string", description: "File slug (lowercase, digits, - or _). Defaults to the title." },
      title: { type: "string" },
      summary: { type: "string", description: `One line, ≤${KNOWLEDGE_SUMMARY_MAX_CHARS} chars.` },
      keywords: KNOWLEDGE_KEYWORDS_PROPERTY,
      content: { type: "string", description: "Markdown body without frontmatter." },
      related_tools: { type: "array", items: { type: "string" }, description: "Builtin tool names the doc talks about." },
      guide_for: {
        type: "array",
        items: { type: "string" },
        description: "Builtin tools this doc is THE detailed guide for (their descriptions then point here). One guide per tool.",
      },
      category_description: { type: "string", description: "Required only when creating a new category." },
      reason: KNOWLEDGE_REASON_PROPERTY,
    },
    required: ["category", "title", "summary", "keywords", "content", "reason"],
  },
  defaultPermissionLevel: 0,
};

export const writeKnowledgeHandler: ToolHandler = async (args, context) => {
  const blocked = abortIfSignaled(context.signal) ?? knowledgeUnavailable();
  if (blocked) return blocked;
  const reason = knowledgeReason(args);
  if (!reason) return missingReasonResult();
  const id = stringArg(args, "id");
  const slug = stringArg(args, "slug");
  const relatedTools = stringListArg(args, "related_tools");
  const guideFor = stringListArg(args, "guide_for");
  const categoryDescription = stringArg(args, "category_description");
  const result = knowledgeBase.write({
    category: stringArg(args, "category") ?? "",
    title: stringArg(args, "title") ?? "",
    summary: stringArg(args, "summary") ?? "",
    keywords: stringListArg(args, "keywords") ?? [],
    content: stringArg(args, "content") ?? "",
    ...(id !== undefined ? { id } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(relatedTools ? { relatedTools } : {}),
    ...(guideFor ? { guideFor } : {}),
    ...(categoryDescription !== undefined ? { categoryDescription } : {}),
  });
  return knowledgeMutationResult("write_knowledge", reason, context.sessionId, result);
};
