import { configureMcpPersistence } from "../mcp/index.js";
import {
  configureSkillPersistence,
} from "../skills/index.js";
import { patchToolsConfig } from "../toolsConfig/store.js";
import { postToolsConfigChanged } from "../toolsConfig/events.js";

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
