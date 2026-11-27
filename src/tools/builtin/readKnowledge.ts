import { knowledgeBase } from "../../knowledge/store.js";
import { KNOWLEDGE_READ_MAX_CHARS } from "../../knowledge/limits.js";
import { findSection, sectionHeadings } from "../../knowledge/parseDoc.js";
import type { KnowledgeDoc } from "../../knowledge/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import { intArg, stringArg } from "./knowledgeArgs.js";

const MAX_LINES = 2000;

export const readKnowledgeDefinition: ToolDefinition = {
  name: "read_knowledge",
  description:
    'Read one knowledge-base doc by id ("category/slug", from the [Knowledge base] list or search_knowledge). Pass section to read a single "##" section of a long doc, or offset/limit for a line range.',
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: 'Doc id, e.g. "computer-use/windows-basics".' },
      section: { type: "string", description: 'Optional "##" heading (case-insensitive, partial match allowed).' },
      offset: { type: "integer", minimum: 1, description: "1-based start line of the body." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LINES, description: "Number of body lines." },
    },
    required: ["id"],
  },
  defaultPermissionLevel: 0,
};

function header(doc: KnowledgeDoc): string[] {
  const source =
    doc.source === "override"
      ? `override of built-in v${doc.builtinVersion ?? "?"}${doc.stale ? ` (stale: based on built-in v${doc.baseVersion ?? 0}; a newer built-in version exists — compare and refresh with write_knowledge)` : ""}`
      : doc.source;
  const lines = [
    `# ${doc.title}`,
    `Id: ${doc.id} · Source: ${source} · Version: ${doc.version}${doc.updatedAt ? ` · Updated: ${doc.updatedAt}` : ""}`,
    `Summary: ${doc.summary}`,
  ];
  if (doc.guideFor.length > 0) lines.push(`Guide for: ${doc.guideFor.join(", ")}`);
  if (doc.relatedTools.length > 0) lines.push(`Related tools: ${doc.relatedTools.join(", ")}`);
  return lines;
}

function capped(text: string): string {
  if (text.length <= KNOWLEDGE_READ_MAX_CHARS) return text;
  return `${text.slice(0, KNOWLEDGE_READ_MAX_CHARS)}\n\nNote: truncated at ${KNOWLEDGE_READ_MAX_CHARS} characters; read by section or offset/limit.`;
}

export const readKnowledgeHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;
  if (!knowledgeBase.isConfigured()) {
    return failureResult("The knowledge base is not available in this host.", ToolReturnCode.NotFound);
  }
  const id = stringArg(args, "id")?.trim() ?? "";
  if (!id) return failureResult('Invalid arguments: "id" is required.', ToolReturnCode.InvalidArguments);
  const doc = knowledgeBase.getDoc(id);
  if (!doc) {
    const near = knowledgeBase.search({ query: id.replace(/[/_-]/g, " "), limit: 5 }).hits.map((hit) => hit.doc.id);
    return failureResult(
      `No knowledge doc ${JSON.stringify(id)}.${near.length > 0 ? ` Closest: ${near.join(", ")}.` : ""} Use search_knowledge to find ids.`,
      ToolReturnCode.NotFound,
    );
  }

  const section = stringArg(args, "section")?.trim() ?? "";
  if (section) {
    const found = findSection(doc.body, section);
    if (!found) {
      const headings = sectionHeadings(doc.body);
      return failureResult(
        `No section ${JSON.stringify(section)} in ${doc.id}. Sections: ${headings.join(" | ") || "(none)"}.`,
        ToolReturnCode.NotFound,
      );
    }
    return textResult(capped([...header(doc), "", found.text].join("\n")), ToolReturnCode.Success);
  }

  const offset = intArg(args, "offset");
  const limit = intArg(args, "limit");
  if (offset !== undefined || limit !== undefined) {
    const lines = doc.body.split("\n");
    const start = Math.max(1, offset ?? 1);
    const count = Math.max(1, Math.min(MAX_LINES, limit ?? MAX_LINES));
    if (start > lines.length) {
      return textResult(
        [...header(doc), "", `Offset ${start} is past the end (${lines.length} lines).`].join("\n"),
        ToolReturnCode.Success,
      );
    }
    const end = Math.min(lines.length, start + count - 1);
    return textResult(
      capped([...header(doc), `Lines ${start}-${end} of ${lines.length}`, "", ...lines.slice(start - 1, end)].join("\n")),
      ToolReturnCode.Success,
    );
  }

  return textResult(capped([...header(doc), "", doc.body].join("\n")), ToolReturnCode.Success);
};
