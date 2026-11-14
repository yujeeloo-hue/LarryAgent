import {
  TOOL_CATEGORY_BY_NAME,
  groupToolsByCategory,
  type ToolCatalogEntry,
  type ToolCategoryId,
} from "./catalog.js";
import {
  clearToolPermissionOverride,
  resolvePermissionLevel,
  setToolPermissionLevel,
} from "./config.js";
import {
  clearAllToolOfferOverrides,
  clearToolOfferOverride,
  getToolOfferOverride,
  setToolOfferAutoBaseline,
  setToolOfferOverride,
} from "./offerConfig.js";
import {
  computeAutoOrganizeBaseline,
  isForcedOfferTool,
  isToolAlwaysOffered,
  resolveAlwaysOfferedToolNames,
} from "./offerSet.js";
import {
  ALWAYS_VISIBLE_TOOLS,
  clearToolDisplayOverride,
  isToolCardVisible,
  setToolDisplayOverride,
} from "./displayConfig.js";
import { getToolDisplayMeta } from "./displayMeta.js";
import { getToolUiDescription, getMcpToolUiDescription } from "./uiDescriptions.js";
import { isMcpToolName } from "../mcp/toolNames.js";
import { getTool, listTools } from "./registry.js";
import { getToolStatsSummary } from "../toolStats/recorder.js";
import type { BuiltinToolName, PermissionLevel } from "./types.js";

function isBuiltinToolName(name: string): name is BuiltinToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_CATEGORY_BY_NAME, name);
}

function callCountMap(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    for (const row of getToolStatsSummary()) {
      map.set(row.name, row.calls);
    }
  } catch {
    // Stats may be unconfigured in tests.
  }
  return map;
}

function toCatalogEntry(
  name: string,
  counts: Map<string, number>,
): ToolCatalogEntry | null {
  const registered = getTool(name);
  if (!registered) return null;
  const { definition } = registered;
  // Connected MCP tools are listed under each MCP server card, not here.
  if (!isBuiltinToolName(definition.name)) return null;
  const meta = getToolDisplayMeta(definition.name);
  const categoryId: ToolCategoryId = TOOL_CATEGORY_BY_NAME[definition.name];
  const permissionLevel = resolvePermissionLevel(
    definition.name,
    definition.defaultPermissionLevel,
  );
  const offered = isToolAlwaysOffered(definition.name);
  return {
    name: definition.name,
    displayName: meta.displayName,
    description: definition.description,
    displayDescription: getToolUiDescription(definition.name),
    categoryId,
    defaultPermissionLevel: definition.defaultPermissionLevel,
    permissionLevel,
    offered,
    offerLocked: isForcedOfferTool(definition.name),
    visible: isToolCardVisible(definition.name),
    ...(ALWAYS_VISIBLE_TOOLS.has(definition.name)
      ? { displayLocked: true }
      : {}),
    callCount: counts.get(definition.name) ?? 0,
  };
}

/**
 * Snapshot of built-in tools for the Tools management UI.
 * Caller must ensure `registerBuiltins()` has already run.
 */
export function listToolCatalog(): ToolCatalogEntry[] {
  const counts = callCountMap();
  const entries: ToolCatalogEntry[] = [];
  for (const { definition } of listTools()) {
    const entry = toCatalogEntry(definition.name, counts);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function listToolCatalogGrouped(): ReturnType<
  typeof groupToolsByCategory
> {
  return groupToolsByCategory(listToolCatalog());
}

export type ToolPermissionUpdate = {
  name: string;
  displayName: string;
  description: string;
  displayDescription: string;
  defaultPermissionLevel: PermissionLevel;
  permissionLevel: PermissionLevel;
  offered: boolean;
  offerLocked?: boolean;
  visible: boolean;
  displayLocked?: boolean;
  callCount?: number;
};

function catalogSnapshotFor(name: string): ToolPermissionUpdate {
  const registered = getTool(name);
  if (!registered) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const toolName = registered.definition.name;
  const permissionLevel = resolvePermissionLevel(
    toolName,
    registered.definition.defaultPermissionLevel,
  );
  const displayName = isMcpToolName(toolName)
    ? toolName
    : getToolDisplayMeta(toolName).displayName;
  const counts = callCountMap();
  return {
    name: toolName,
    displayName,
    description: registered.definition.description,
    displayDescription: isMcpToolName(toolName)
      ? getMcpToolUiDescription(toolName.split("__").slice(2).join("__"), "this MCP server")
      : getToolUiDescription(toolName),
    defaultPermissionLevel: registered.definition.defaultPermissionLevel,
    permissionLevel,
    offered: isMcpToolName(toolName) ? false : isToolAlwaysOffered(toolName),
    offerLocked: isForcedOfferTool(toolName) || isMcpToolName(toolName),
    visible: isMcpToolName(toolName) ? true : isToolCardVisible(toolName),
    ...(!isMcpToolName(toolName) && ALWAYS_VISIBLE_TOOLS.has(toolName)
      ? { displayLocked: true }
      : {}),
    callCount: counts.get(toolName) ?? 0,
  };
}

/**
 * Set effective permission for a built-in or MCP registry tool.
 * MCP tools use registry names (`mcp__…`).
 */
export function setToolCatalogPermission(
  name: string,
  level: PermissionLevel,
): ToolPermissionUpdate {
  const registered = getTool(name);
  if (!registered) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const toolName = registered.definition.name;
  if (level === registered.definition.defaultPermissionLevel) {
    clearToolPermissionOverride(toolName);
  } else {
    setToolPermissionLevel(toolName, level);
  }
  return catalogSnapshotFor(toolName);
}

export type ToolOfferUpdate = ToolPermissionUpdate;

/**
 * Set whether a tool is always offered to the model.
 * Forced metas cannot be deferred.
 */
export function setToolCatalogOffer(
  name: string,
  include: boolean,
): ToolOfferUpdate {
  const registered = getTool(name);
  if (!registered) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const toolName = registered.definition.name;
  if (isMcpToolName(toolName)) {
    clearToolOfferOverride(toolName);
    throw new Error(
      "MCP tools cannot be Include'd — use search_tools → tool_describe → tool_call.",
    );
  }
  if (isForcedOfferTool(toolName)) {
    clearToolOfferOverride(toolName);
    return catalogSnapshotFor(toolName);
  }

  const currently = isToolAlwaysOffered(toolName);
  if (include === currently && getToolOfferOverride(toolName) === undefined) {
    return catalogSnapshotFor(toolName);
  }

  // Align override with intent relative to resolved baseline membership.
  setToolOfferOverride(toolName, include);
  return catalogSnapshotFor(toolName);
}

/**
 * Set whether a tool's card renders in the conversation flow.
 * Hidden tools still execute and are stored in the session.
 * Always-visible tools (ask panels / plan progress) stay visible.
 */
export function setToolCatalogDisplay(
  name: string,
  visible: boolean,
): ToolPermissionUpdate {
  const registered = getTool(name);
  if (!registered) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const toolName = registered.definition.name;
  if (isMcpToolName(toolName) || ALWAYS_VISIBLE_TOOLS.has(toolName)) {
    clearToolDisplayOverride(toolName);
    return catalogSnapshotFor(toolName);
  }
  if (visible) {
    clearToolDisplayOverride(toolName);
  } else {
    setToolDisplayOverride(toolName, false);
  }
  return catalogSnapshotFor(toolName);
}

/**
 * Auto-organize always-offer set from tool-stats (or defaults when empty).
 * Replaces baseline and clears manual offer overrides.
 */
export function autoOrganizeToolOffers(): {
  baseline: string[];
  offered: string[];
} {
  const registryNames = listTools().map((t) => t.definition.name);
  let callCounts: Array<{ name: string; calls: number }> = [];
  try {
    callCounts = getToolStatsSummary().map((r) => ({
      name: r.name,
      calls: r.calls,
    }));
  } catch {
    callCounts = [];
  }

  const baseline = computeAutoOrganizeBaseline({
    registryNames,
    callCounts,
  });
  clearAllToolOfferOverrides();
  setToolOfferAutoBaseline(baseline);
  const offered = [...resolveAlwaysOfferedToolNames(registryNames)].sort();
  return { baseline, offered };
}
