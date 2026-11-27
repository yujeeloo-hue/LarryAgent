import { isMcpToolName } from "../../mcp/toolNames.js";
import type { ToolBridgeScope } from "../../tools/toolBridge.js";
import { isBridgeInScope, isBridgeMetaTool } from "../../tools/toolBridge.js";
import {
  EXPLORE_DANGER_DENYLIST,
  EXPLORE_EAGER_TOOL_ALLOWLIST,
  SUBAGENT_TOOL_DENYLIST,
} from "./constants.js";
import type { SubagentRole } from "./types.js";

export function bridgeScopeForSubagent(role: SubagentRole): ToolBridgeScope {
  return {
    denylist:
      role === "explore" ? EXPLORE_DANGER_DENYLIST : SUBAGENT_TOOL_DENYLIST,
  };
}

export function isToolAllowedForSubagent(
  name: string,
  role: SubagentRole,
): boolean {
  return isBridgeInScope(name, bridgeScopeForSubagent(role));
}

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

export function subagentToolPredicate(
  role: SubagentRole,
): (name: string) => boolean {
  return (name) => isEagerToolAllowedForSubagent(name, role);
}
