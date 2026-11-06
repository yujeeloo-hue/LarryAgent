import { parseSearchToolKeywords } from "../offerSet.js";
import { skillManager } from "../../skills/manager.js";
import type { SkillCatalogEntry } from "../../skills/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

const DEFAULT_LIMIT = 16;
const MAX_LIMIT = 32;
const DESC_PREVIEW = 160;

/** Default level: 0 — discovery meta-tool; always offered. */
export const searchSkillsDefinition: ToolDefinition = {
  name: "search_skills",
  description:
    "Search enabled skills by keywords (AND over name + description). Omit query to list all. Next: read_skill({ name }) for full SKILL.md and files. Does not add skills to the system prompt.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Keywords (space/comma separated); all must match. Omit or empty to list enabled skills.",
      },
      limit: {
        type: "integer",
        description: `Max skills to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: [],
  },
  defaultPermissionLevel: 0,
};

function parseLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) {
      return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
    }
  }
  return DEFAULT_LIMIT;
}

function previewDescription(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= DESC_PREVIEW) return one;
  return `${one.slice(0, DESC_PREVIEW - 1)}…`;
}

/** AND-match enabled skill catalog; empty query lists in name order. */
export function filterSkillCatalog(
  entries: SkillCatalogEntry[],
  query: string,
  limit: number,
): SkillCatalogEntry[] {
  const cap = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const keywords = parseSearchToolKeywords(query);
  if (keywords.length === 0) {
    return entries.slice(0, cap);
  }

  const hits: Array<{ entry: SkillCatalogEntry; score: number }> = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const description = entry.description.toLowerCase();
    let nameHits = 0;
    let descHits = 0;
    let miss = false;
    for (const kw of keywords) {
      const inName = name.includes(kw);
      const inDesc = description.includes(kw);
      if (!inName && !inDesc) {
        miss = true;
        break;
      }
      if (inName) nameHits += 1;
      else descHits += 1;
    }
    if (miss) continue;
    hits.push({ entry, score: nameHits * 1000 + descHits });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return hits.slice(0, cap).map((h) => h.entry);
}

export const searchSkillsHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const query = typeof args.query === "string" ? args.query.trim() : "";
  const limit = parseLimit(args.limit);
  const hits = filterSkillCatalog(
    skillManager.listEnabledCatalog(),
    query,
    limit,
  );

  if (hits.length === 0) {
    const catalog = skillManager.listEnabledCatalog();
    if (catalog.length === 0) {
      return textResult(
        "No enabled skills. Create one with create_skill, or enable an existing skill in Skills.",
        ToolReturnCode.Success,
      );
    }
    return textResult(
      `No enabled skills matched query ${JSON.stringify(query)}. Try different keywords, or omit query to list all.`,
      ToolReturnCode.Success,
    );
  }

  const names = hits.map((h) => h.name);
  const lines = hits.map(
    (h) => `- ${h.name}: ${previewDescription(h.description)}`,
  );
  const listedAll = !query;

  return textResult(
    [
      listedAll
        ? `Enabled skill(s) (${names.length}): ${names.join(", ")}.`
        : `Found ${names.length} skill(s): ${names.join(", ")}.`,
      "Next: read_skill({ name }) for SKILL.md and supporting files.",
      "",
      ...lines,
    ].join("\n"),
    ToolReturnCode.Success,
  );
};
