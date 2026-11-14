import { parseSearchToolKeywords } from "../offerSet.js";
import { skillManager } from "../../skills/manager.js";
import {
  filterCatalogForProject,
  skillProjectKey,
} from "../../skills/projectScope.js";
import { rankBySimilarity } from "../../skills/similarity.js";
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
    "Find installed skills — user-provided playbooks for recurring workflows (build/release, conversions, domain APIs, conventions). Check before starting a specialized task and follow a matching skill instead of improvising. Search by keywords (AND over name + description; related skills follow); omit query to list all. include_inactive also searches disabled and deprecated skills (use before creating or merging skills). Next: read_skill({ name }) for full SKILL.md and files. Does not add skills to the system prompt.",
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
      include_inactive: {
        type: "boolean",
        description:
          "Also search disabled and deprecated skills (default false).",
      },
      scope: {
        type: "string",
        enum: ["project", "all"],
        description:
          'Default "project": only universal skills plus this project\'s own. Use "all" to search every project\'s skills.',
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

function statusTag(entry: SkillCatalogEntry): string {
  if (entry.status === "deprecated") {
    return entry.supersededByName
      ? ` [deprecated → ${entry.supersededByName}]`
      : " [deprecated]";
  }
  return entry.enabled === false ? " [disabled]" : "";
}

/**
 * Entries that miss some keyword but are lexically close to the query,
 * ranked by BM25 — shown after the AND hits.
 */
export function relatedSkillEntries(
  entries: SkillCatalogEntry[],
  query: string,
  exclude: ReadonlySet<string>,
  limit: number,
): SkillCatalogEntry[] {
  if (limit <= 0 || !query.trim()) return [];
  const pool = entries.filter((e) => !exclude.has(e.name));
  const byName = new Map(pool.map((e) => [e.name, e]));
  return rankBySimilarity(
    query,
    pool.map((e) => ({ id: e.name, text: `${e.name.replace(/-/g, " ")} ${e.description}` })),
    limit,
  )
    .map((hit) => byName.get(hit.id))
    .filter((e): e is SkillCatalogEntry => Boolean(e));
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
  const includeInactive = args.include_inactive === true || args.include_inactive === "true";
  const scopeAll = args.scope === "all";
  const projectKey = skillProjectKey(context.workspacePath);
  const allSkills = skillManager.listEnabledCatalog({ includeInactive });
  const catalog = scopeAll
    ? allSkills
    : filterCatalogForProject(allSkills, projectKey);
  const hiddenByProject = allSkills.length - catalog.length;
  const hits = filterSkillCatalog(catalog, query, limit);
  const related = relatedSkillEntries(
    catalog,
    query,
    new Set(hits.map((h) => h.name)),
    Math.min(5, limit - hits.length),
  );

  const scopeHint =
    !scopeAll && hiddenByProject > 0
      ? ` ${hiddenByProject} more belong to other projects — pass scope:"all" to include them.`
      : "";

  if (hits.length === 0 && related.length === 0) {
    if (catalog.length === 0) {
      return textResult(
        allSkills.length === 0
          ? "No enabled skills. Create one with create_skill, or enable an existing skill in Skills."
          : `No enabled skills for project ${projectKey || "(none)"}.${scopeHint}`,
        ToolReturnCode.Success,
      );
    }
    return textResult(
      `No enabled skills matched query ${JSON.stringify(query)} (${catalog.length} enabled). Keywords must all appear in a skill's name or description — call search_skills again with no query to list all ${catalog.length} before concluding none applies.${scopeHint}`,
      ToolReturnCode.Success,
    );
  }

  const names = hits.map((h) => h.name);
  const line = (h: SkillCatalogEntry): string =>
    `- ${h.name}${statusTag(h)}${h.project ? ` [${h.project}]` : ""}: ${previewDescription(h.description)}`;
  const listedAll = !query;
  const scope = includeInactive ? "skill(s)" : "enabled skill(s)";

  return textResult(
    [
      listedAll
        ? `${includeInactive ? "Skill(s)" : "Enabled skill(s)"} (${names.length}): ${names.join(", ")}.`
        : names.length > 0
          ? `Found ${names.length} ${scope}: ${names.join(", ")}.`
          : `No ${scope} matched every keyword of ${JSON.stringify(query)}.`,
      `Next: read_skill({ name }) for SKILL.md and supporting files.${scopeHint}`,
      "",
      ...hits.map(line),
      ...(related.length > 0 ? ["", "Related:", ...related.map(line)] : []),
    ].join("\n"),
    ToolReturnCode.Success,
  );
};
