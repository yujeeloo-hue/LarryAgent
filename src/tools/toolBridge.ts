import { listTools } from "./registry.js";
import {
  FORCED_OFFER_TOOL_NAMES,
  canOfferToolEagerly,
  isForcedOfferTool,
  resolveAlwaysOfferedToolNames,
} from "./offerSet.js";

/** Bridge meta-tools (always forced-offer). */
export const TOOL_BRIDGE_NAMES = [
  "search_tools",
  "tool_describe",
  "tool_call",
] as const;

export type ToolBridgeScope = {
  /** When set, only these names pass (after denylist). */
  allowlist?: ReadonlySet<string>;
  /** Always blocked. */
  denylist?: ReadonlySet<string>;
};

/** MCP tools are never eager-eligible. */
export function isEagerEligibleName(name: string): boolean {
  return canOfferToolEagerly(name);
}

export function isBridgeMetaTool(name: string): boolean {
  return (TOOL_BRIDGE_NAMES as readonly string[]).includes(name);
}

/**
 * Whether a tool is in the current eager offer set (forced + Hot/Include builtins).
 * MCP is never eager.
 */
export function isEagerTool(
  name: string,
  registryNames?: Iterable<string>,
): boolean {
  const key = name.trim();
  if (!key || !isEagerEligibleName(key)) return false;
  if (isForcedOfferTool(key)) return true;
  return resolveAlwaysOfferedToolNames(registryNames).has(key);
}

/**
 * Bridge scope check: denylist wins; unset allowlist = unrestricted (aside from denylist).
 */
export function isBridgeInScope(
  name: string,
  scope?: ToolBridgeScope | null,
): boolean {
  const key = name.trim();
  if (!key) return false;
  if (scope?.denylist?.has(key)) return false;
  if (scope?.allowlist && scope.allowlist.size > 0) {
    return scope.allowlist.has(key);
  }
  return true;
}

/**
 * Deferred catalog names: registry minus eager set, filtered by bridge scope.
 */
export function listDeferredToolNames(input?: {
  registryNames?: Iterable<string>;
  scope?: ToolBridgeScope | null;
}): string[] {
  const registry =
    input?.registryNames !== undefined
      ? [...input.registryNames].map((n) => n.trim()).filter(Boolean)
      : listTools().map((t) => t.definition.name);
  const eager = resolveAlwaysOfferedToolNames(registry);
  // Forced metas are eager; ensure bridge names never appear as deferred targets.
  for (const n of FORCED_OFFER_TOOL_NAMES) eager.add(n);

  const out: string[] = [];
  for (const name of registry) {
    if (eager.has(name)) continue;
    if (!isBridgeInScope(name, input?.scope)) continue;
    out.push(name);
  }
  return out;
}

export function deferredNameSet(input?: {
  registryNames?: Iterable<string>;
  scope?: ToolBridgeScope | null;
}): Set<string> {
  return new Set(listDeferredToolNames(input));
}
