/**
 * Which tools are offered to the model each iteration (vs deferred until
 * discovered via search_tools → tool_describe → tool_call).
 */

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

/**
 * Max tools Auto-organize / default baseline may select (forced metas do not
 * count). Manual Include may exceed this. Must cover every entry of
 * DEFAULT_OFFERED_TOOL_NAMES — at 16 the 17th default (`symbols`) was
 * silently truncated into deferred on every fresh install.
 */
export const MAX_USER_OFFERED_TOOLS = 18;

/**
 * Always offered; Include toggle locked On in Tools UI.
 * Interaction / discovery gates must never be deferred.
 */
export const FORCED_OFFER_TOOL_NAMES = new Set<string>([
  "search_tools",
  "tool_describe",
  "tool_call",
  "ask_user",
  "request_full_permissions",
  /** Plan-mode control signal: analyser must always be able to finish routing. */
  "fsm_route",
  /** Plan-mode gate: must never be deferred or plan_writer cannot write docs/plans/. */
  "write_plan_doc",
  "adopt_plan_doc",
  /** Skill discovery gate: catalog is not injected into Bucket0. */
  "search_skills",
]);

/**
 * First-use / empty-stats recommendation (≤ MAX_USER_OFFERED_TOOLS, excludes
 * forced metas).
 */
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

/** MCP and empty names cannot be Include'd / Auto-organized into eager tools[]. */
export function canOfferToolEagerly(name: string): boolean {
  const key = name.trim();
  if (!key) return false;
  if (isMcpToolName(key)) return false;
  return true;
}

/**
 * Defaults introduced after users may already have a saved Auto-organize
 * baseline (which never gains zero-call tools). Each is offered right after
 * its anchor when the anchor is in that baseline; Defer still removes it.
 */
const BASELINE_COMPANIONS: Readonly<Record<string, string>> = {
  grep: "glob",
};

/** Effective baseline: last Auto-organize snapshot, else built-in defaults. */
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

/**
 * Ordered user-include list, excluding forced metas and MCP.
 * Baseline / Auto-organize slots are capped at {@link MAX_USER_OFFERED_TOOLS}.
 * Explicit Include overrides (`true`) are always added and may exceed that cap;
 * explicit Defer (`false`) removes a baseline name.
 */
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

  // Manual Include may exceed the Auto-organize cap of 16.
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

/** Always-offer names for a turn (forced + user list). MCP never included. */
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

/**
 * Predicate for toolsToOpenAi: always-offer set only (no mid-turn activation).
 * Subagent turns should skip this and use role filters + bridges.
 * Forced meta tools (search_tools, ask_user, …) are always included in the set.
 */
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

/** Split query into keywords (whitespace + commas). */
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

  // Prefer name matches, then description, then category.
  return nameHits * 1000 + descHits * 10 + categoryHits;
}

/**
 * Multi-keyword AND search over the registry.
 * @param excludeNames tools already offered (eager) — omitted from results
 * @param includeNames when set, only search within this deferred catalog
 */
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

/**
 * Pick top N registry tools by call count for Auto-organize.
 * Empty / zero stats → default recommendation. MCP never selected.
 */
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

  // Fill remaining slots from defaults if stats cover fewer than 16 tools.
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
