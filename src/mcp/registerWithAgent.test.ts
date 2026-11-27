import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ToolReturnCode } from "../session/returnCodes.js";
import { searchRegistryTools } from "../tools/offerSet.js";
import { getTool } from "../tools/registry.js";
import {
  syncServerToolsToRegistry,
  unregisterServerToolsFromRegistry,
} from "./registerWithAgent.js";
import { encodeMcpToolName } from "./toolNames.js";

const SERVER_ID = "test-mcp-display-name";
const SERVER_NAME = "ClickHero";

const noopCall = async () => ({
  content: [{ type: "text" as const, text: "ok" }],
  returnCode: ToolReturnCode.Success,
});

function registerMouseTool() {
  const [tool] = syncServerToolsToRegistry(
    SERVER_ID,
    SERVER_NAME,
    [
      {
        serverId: SERVER_ID,
        originalName: "mouse",
        description: "鼠标控制（真实 CGEvent 系统事件）",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    noopCall,
  );
  assert.ok(tool);
  return tool;
}

afterEach(() => {
  unregisterServerToolsFromRegistry(SERVER_ID);
});

describe("MCP tool discovery by server display name", () => {
  it("labels registered tool descriptions without changing registry names", () => {
    const tool = registerMouseTool();
    assert.equal(tool.registryName, encodeMcpToolName(SERVER_ID, "mouse"));
    assert.equal(
      getTool(tool.registryName)?.definition.description,
      "[ClickHero] 鼠标控制（真实 CGEvent 系统事件）",
    );
  });

  it("finds the tool by server display name and by capability keyword", () => {
    const tool = registerMouseTool();

    const byServer = searchRegistryTools({ query: "clickhero", limit: 8 });
    assert.ok(
      byServer.some((hit) => hit.name === tool.registryName),
      "search by server display name should hit the MCP tool",
    );

    const byCapability = searchRegistryTools({ query: "mouse", limit: 8 });
    assert.ok(
      byCapability.some((hit) => hit.name === tool.registryName),
      "capability keyword should still hit the MCP tool",
    );

    const noMatch = searchRegistryTools({
      query: "clickhero nonexistent",
      limit: 8,
    });
    assert.ok(
      !noMatch.some((hit) => hit.name === tool.registryName),
      "AND matching must still reject unrelated keywords",
    );
  });
});
