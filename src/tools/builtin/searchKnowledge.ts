import { knowledgeBase } from "../../knowledge/store.js";
import { KNOWLEDGE_SEARCH_RESULT_MAX_CHARS } from "../../knowledge/limits.js";
import type { KnowledgeDoc } from "../../knowledge/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import { intArg, stringArg } from "./knowledgeArgs.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export const searchKnowledgeDefinition: ToolDefinition = {
  name: "search_knowledge",
  description:
    "Search the agent's internal knowledge base: reference docs for complex capabilities (Computer Use, FSM graphs, plan mode, subagents, MCP / skills, Unreal Editor, development tools). Keywords (English or Chinese) are matched over title, keywords, summary, headings and body; an exact tool name ranks that tool's guide first. Omit query to list categories and docs. Next: read_knowledge({ id }).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords; all must match (falls back to partial matches). Omit to list." },
      category: { type: "string", description: "Limit to one category id." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Max docs (default ${DEFAULT_LIMIT}).` },
    },
    required: [],
  },
  defaultPermissionLevel: 0,
};

function sourceTag(doc: KnowledgeDoc): string {
  if (doc.source === "override") return doc.stale ? " [override, stale]" : " [override]";
  return doc.source === "user" ? " [user]" : "";
}

function docLine(doc: KnowledgeDoc): string {
  const keywords = doc.keywords.slice(0, 8).join(", ");
  return `- ${doc.id}${sourceTag(doc)}: ${doc.title} — ${doc.summary}${keywords ? ` (keywords: ${keywords})` : ""}`;
}

function clip(lines: string[]): string {
  let text = "";
  for (const line of lines) {
    if (text.length + line.length + 1 > KNOWLEDGE_SEARCH_RESULT_MAX_CHARS) {
      return `${text}\nNote: result truncated at ${KNOWLEDGE_SEARCH_RESULT_MAX_CHARS} characters; narrow the query or pass category.`;
    }
    text += text ? `\n${line}` : line;
  }
  return text;
}

export const searchKnowledgeHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;
  if (!knowledgeBase.isConfigured()) {
    return failureResult("The knowledge base is not available in this host.", ToolReturnCode.NotFound);
  }
  const query = stringArg(args, "query")?.trim() ?? "";
  const category = stringArg(args, "category")?.trim() ?? "";
  const limit = Math.max(1, Math.min(MAX_LIMIT, intArg(args, "limit") ?? DEFAULT_LIMIT));
  const categories = knowledgeBase.listCategories();
  if (category && !categories.some((c) => c.id === category)) {
    return failureResult(
      `Unknown category ${JSON.stringify(category)}. Categories: ${categories.map((c) => c.id).join(", ") || "(none)"}.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  if (!query) {
    const docs = knowledgeBase.listDocs();
    const shown = category ? categories.filter((c) => c.id === category) : categories;
    const lines = [`Knowledge base: ${docs.length} doc(s) in ${categories.length} categor${categories.length === 1 ? "y" : "ies"}. Next: read_knowledge({ id }).`];
    for (const c of shown) {
      lines.push("", `## ${c.id}${c.description ? ` — ${c.description}` : ""}`);
      for (const doc of docs.filter((d) => d.category === c.id)) lines.push(docLine(doc));
    }
    return textResult(clip(lines), ToolReturnCode.Success);
  }

  const result = knowledgeBase.search({ query, ...(category ? { category } : {}), limit });
  if (result.hits.length === 0) {
    return textResult(
      `No knowledge docs matched ${JSON.stringify(query)}. Call search_knowledge with no query to list every doc before concluding none applies.`,
      ToolReturnCode.Success,
    );
  }
  const lines = [
    `Found ${result.hits.length} doc(s) for ${JSON.stringify(query)}. Next: read_knowledge({ id }) — pass section to read one "##" section.`,
  ];
  if (result.mode === "or") lines.push("Note: no doc matched every keyword; showing partial matches.");
  lines.push("", ...result.hits.map((hit) => docLine(hit.doc)));
  return textResult(clip(lines), ToolReturnCode.Success);
};
