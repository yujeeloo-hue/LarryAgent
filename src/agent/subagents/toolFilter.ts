import { isMcpToolName } from "../../mcp/toolNames.js";
import type { ToolBridgeScope } from "../../tools/toolBridge.js";
import { isBridgeInScope, isBridgeMetaTool } from "../../tools/toolBridge.js";
import {
  EXPLORE_DANGER_DENYLIST,
  EXPLORE_EAGER_TOOL_ALLOWLIST,
  SUBAGENT_TOOL_DENYLIST,
} from "./constants.js";
import type { SubagentRole } from "./types.js";

/** Bridge/search/describe/call scope for a subagent role. */
export function bridgeScopeForSubagent(role: SubagentRole): ToolBridgeScope {
  return {
    denylist:
      role === "explore" ? EXPLORE_DANGER_DENYLIST : SUBAGENT_TOOL_DENYLIST,
  };
}

/**
 * Whether a registry tool may be reached via the bridge (search/describe/call)
 * or executed under bridge-scope enforcement.
 * Explore: danger denylist only (MCP allowed). General/worker: management denylist.
 */
export function isToolAllowedForSubagent(
  name: string,
  role: SubagentRole,
): boolean {
  return isBridgeInScope(name, bridgeScopeForSubagent(role));
}

/**
 * Whether a tool may appear in the child's eager tools[] array.
 * MCP is never eager; explore uses a lean read allowlist + bridges.
 */
export function isEagerToolAllowedForSubagent(
  name: string,
  role: SubagentRole,
): boolean {
  if (isMcpToolName(name)) return false;
  if (!isToolAllowedForSubagent(name, role)) return false;
  if (role === "explore") {
    return EXPLORE_EAGER_TOOL_ALLOWLIST.has(name) || isBridgeMetaTool(name);
  }
  return true;
}

/** Model-visibility predicate for subagent tools[] (eager only). */
export function subagentToolPredicate(
  role: SubagentRole,
): (name: string) => boolean {
  return (name) => isEagerToolAllowedForSubagent(name, role);
}
