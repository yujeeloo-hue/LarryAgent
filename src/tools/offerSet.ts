
import { isMcpToolName } from "../mcp/toolNames.js";
import { TOOL_CATEGORY_BY_NAME, type ToolCategoryId } from "./catalog.js";
import {
  getToolOfferAutoBaseline,
  getToolOfferOverride,
  getAllToolOfferOverrides,
} from "./offerConfig.js";
import { SHELL_TOOL_NAME } from "./shellToolName.js";
import { getToolDisplayMeta } from "./displayMeta.js";
import { listTools } from "./registry.js";
import type { BuiltinToolName } from "./types.js";

export const MAX_USER_OFFERED_TOOLS = 18;

export const FORCED_OFFER_TOOL_NAMES = new Set<string>([
  "search_tools",
  "tool_describe",
  "tool_call",
  "ask_user",
  "request_full_permissions",
  "fsm_route",
  "write_plan_doc",
  "adopt_plan_doc",
  "search_skills",
  "search_knowledge",
  "read_knowledge",
]);

export const DEFAULT_OFFERED_TOOL_NAMES: readonly string[] = [
  "read_file",
  "write_file",
  "patch",
  "list_dir",
  "grep",
  "glob",
  SHELL_TOOL_NAME,
  "create_plan",
  "update_plan",
  "complete_plan",
  "read_project_memory",
  "update_project_memory",
  "dispatch_subagent",
  "await_subagent",
  "read_skill",
  "get_current_time",
  "batch_search",
  "symbols",
] as const;

export function isForcedOfferTool(name: string): boolean {
  return FORCED_OFFER_TOOL_NAMES.has(name);
}

export function canOfferToolEagerly(name: string): boolean {
  const key = name.trim();
  if (!key) return false;
  if (isMcpToolName(key)) return false;
  return true;
}

const BASELINE_COMPANIONS: Readonly<Record<string, string>> = {
  grep: "glob",
};

export function resolveOfferBaseline(): string[] {
  const stored = getToolOfferAutoBaseline();
  if (stored && stored.length > 0) {
    const out: string[] = [];
    for (const name of stored) {
      if (!canOfferToolEagerly(name)) continue;
      out.push(name);
      const companion = BASELINE_COMPANIONS[name];
      if (companion && !stored.includes(companion)) out.push(companion);
    }
    return out;
  }
  return [...DEFAULT_OFFERED_TOOL_NAMES];
}

export function resolveUserOfferedToolNames(
  registryNames?: Iterable<string>,
): string[] {
  const registry =
    registryNames !== undefined
      ? new Set(
          [...registryNames].map((n) => n.trim()).filter(Boolean),
        )
      : new Set(listTools().map((t) => t.definition.name));

  const baseline = resolveOfferBaseline();
  const ordered: string[] = [];
  const seen = new Set<string>();

  const tryAddBaseline = (name: string): boolean => {
    const key = name.trim();
    if (!key || seen.has(key) || isForcedOfferTool(key)) return false;
    if (!canOfferToolEagerly(key)) return false;
    if (!registry.has(key)) return false;
    if (getToolOfferOverride(key) === false) return false;
    ordered.push(key);
    seen.add(key);
    return ordered.length >= MAX_USER_OFFERED_TOOLS;
  };

  for (const name of baseline) {
    if (tryAddBaseline(name)) break;
  }

  for (const [name, include] of Object.entries(getAllToolOfferOverrides())) {
    if (include !== true) continue;
    const key = name.trim();
    if (!key || seen.has(key) || isForcedOfferTool(key)) continue;
    if (!canOfferToolEagerly(key)) continue;
    if (!registry.has(key)) continue;
    ordered.push(key);
    seen.add(key);
  }

  return ordered;
}

export function resolveAlwaysOfferedToolNames(
  registryNames?: Iterable<string>,
): Set<string> {
  const out = new Set<string>(FORCED_OFFER_TOOL_NAMES);
  for (const name of resolveUserOfferedToolNames(registryNames)) {
    if (canOfferToolEagerly(name)) out.add(name);
  }
  return out;
}

export function isToolAlwaysOffered(
  name: string,
  registryNames?: Iterable<string>,
): boolean {
  if (!canOfferToolEagerly(name) && !isForcedOfferTool(name)) return false;
  if (isForcedOfferTool(name)) return true;
  return resolveAlwaysOfferedToolNames(registryNames).has(name);
}

export function createOfferToolPredicate(
  _activatedToolNames?: ReadonlySet<string>,
  registryNames?: Iterable<string>,
): (name: string) => boolean {
  const always = resolveAlwaysOfferedToolNames(registryNames);
  return (name: string) => always.has(name);
}

export type ToolSearchHit = {
  name: string;
  displayName: string;
  description: string;
  category: string;
  score: number;
};

function categoryLabelFor(name: string): string {
  if (Object.prototype.hasOwnProperty.call(TOOL_CATEGORY_BY_NAME, name)) {
    const id = TOOL_CATEGORY_BY_NAME[name as BuiltinToolName] as ToolCategoryId;
    return id;
  }
  if (isMcpToolName(name)) return "mcp";
  return "other";
}

function displayNameFor(name: string): string {
  try {
    return getToolDisplayMeta(name).displayName;
  } catch {
    return name;
  }
}

export function parseSearchToolKeywords(query: string): string[] {
  const parts = query
    .split(/[\s,]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(parts)];
}

function scoreToolAgainstKeywords(
  name: string,
  description: string,
  keywords: string[],
): number | null {
  const displayName = displayNameFor(name);
  const category = categoryLabelFor(name);
  const fields = {
    name: name.toLowerCase(),
    displayName: displayName.toLowerCase(),
    description: description.toLowerCase(),
    category: category.toLowerCase(),
  };

  let nameHits = 0;
  let descHits = 0;
  let categoryHits = 0;

  for (const kw of keywords) {
    const inName =
      fields.name.includes(kw) || fields.displayName.includes(kw);
    const inDesc = fields.description.includes(kw);
    const inCat = fields.category.includes(kw);
    if (!inName && !inDesc && !inCat) return null;
    if (inName) nameHits += 1;
    else if (inDesc) descHits += 1;
    else categoryHits += 1;
  }

  return nameHits * 1000 + descHits * 10 + categoryHits;
}

export function searchRegistryTools(input: {
  query: string;
  limit: number;
  excludeNames?: ReadonlySet<string>;
  includeNames?: ReadonlySet<string>;
}): ToolSearchHit[] {
  const keywords = parseSearchToolKeywords(input.query);
  if (keywords.length === 0) return [];

  const limit = Math.max(1, Math.min(16, Math.floor(input.limit)));
  const exclude = input.excludeNames ?? new Set<string>();
  const include = input.includeNames;
  const hits: ToolSearchHit[] = [];

  for (const { definition } of listTools()) {
    const name = definition.name;
    if (exclude.has(name)) continue;
    if (include && !include.has(name)) continue;
    const score = scoreToolAgainstKeywords(
      name,
      definition.description ?? "",
      keywords,
    );
    if (score === null) continue;
    hits.push({
      name,
      displayName: displayNameFor(name),
      description: definition.description ?? "",
      category: categoryLabelFor(name),
      score,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
  return hits.slice(0, limit);
}

export function computeAutoOrganizeBaseline(input: {
  registryNames: Iterable<string>;
  callCounts: Array<{ name: string; calls: number }>;
}): string[] {
  const registry = new Set(
    [...input.registryNames].map((n) => n.trim()).filter(Boolean),
  );
  const totalCalls = input.callCounts.reduce(
    (sum, row) => sum + (row.calls > 0 ? row.calls : 0),
    0,
  );

  const eligible = (n: string) =>
    registry.has(n) && !isForcedOfferTool(n) && canOfferToolEagerly(n);

  if (totalCalls <= 0) {
    return DEFAULT_OFFERED_TOOL_NAMES.filter(eligible).slice(
      0,
      MAX_USER_OFFERED_TOOLS,
    );
  }

  const sorted = [...input.callCounts]
    .filter((r) => r.calls > 0 && eligible(r.name))
    .sort((a, b) => {
      if (b.calls !== a.calls) return b.calls - a.calls;
      return a.name.localeCompare(b.name);
    });

  const out: string[] = [];
  for (const row of sorted) {
    if (out.length >= MAX_USER_OFFERED_TOOLS) break;
    out.push(row.name);
  }

  if (out.length < MAX_USER_OFFERED_TOOLS) {
    const seen = new Set(out);
    for (const name of DEFAULT_OFFERED_TOOL_NAMES) {
      if (out.length >= MAX_USER_OFFERED_TOOLS) break;
      if (seen.has(name) || !eligible(name)) continue;
      out.push(name);
      seen.add(name);
    }
  }

  return out;
}
