import { configureMcpPersistence } from "../mcp/index.js";
import {
  configureSkillPersistence,
} from "../skills/index.js";
import { patchToolsConfig } from "../toolsConfig/store.js";
import { postToolsConfigChanged } from "../toolsConfig/events.js";

/**
 * Persist agent-driven MCP/skills mutations back into tools.json — the same
 * store desktop wires in main/index.ts (daemon parity). Call after
 * configureToolsConfigRoot(); without this, create/update/delete_mcp_server
 * and skill mutations only live in memory and vanish on restart.
 */
export function wireToolsConfigPersistence(): void {
  configureMcpPersistence(async (servers) => {
    await patchToolsConfig({ mcpServers: servers });
    postToolsConfigChanged("mcpServers");
  });
  configureSkillPersistence(async (skillConfigs) => {
    await patchToolsConfig({ skills: skillConfigs });
    postToolsConfigChanged("skills");
  });
}
