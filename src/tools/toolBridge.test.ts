import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import {
  canOfferToolEagerly,
  createOfferToolPredicate,
  FORCED_OFFER_TOOL_NAMES,
  isForcedOfferTool,
  resolveAlwaysOfferedToolNames,
} from "./offerSet.js";
import {
  clearToolOfferStateForTests,
  loadToolOfferOverrides,
  setToolOfferAutoBaseline,
} from "./offerConfig.js";
import {
  deferredNameSet,
  isBridgeInScope,
  isEagerTool,
  listDeferredToolNames,
} from "./toolBridge.js";
import { upsertTool } from "./registry.js";
import { registerBuiltins } from "./index.js";
import {
  bridgeScopeForSubagent,
  isEagerToolAllowedForSubagent,
  isToolAllowedForSubagent,
} from "../agent/subagents/toolFilter.js";

before(() => {
  registerBuiltins();
});

describe("tool bridge offer set", () => {
  it("forces discovery and FSM control tools", () => {
    assert.ok(isForcedOfferTool("search_tools"));
    assert.ok(isForcedOfferTool("tool_describe"));
    assert.ok(isForcedOfferTool("tool_call"));
    assert.ok(isForcedOfferTool("search_skills"));
    assert.ok(isForcedOfferTool("fsm_route"));
    assert.ok(FORCED_OFFER_TOOL_NAMES.has("tool_call"));
  });

  it("never offers MCP eagerly", () => {
    clearToolOfferStateForTests();
    assert.equal(canOfferToolEagerly("mcp__tavily__search"), false);
    upsertTool(
      {
        name: "mcp__tavily__search",
        description: "web search",
        parameters: { type: "object", properties: {} },
        defaultPermissionLevel: 0,
      },
      async () => ({ content: [{ type: "text", text: "ok" }], returnCode: 0 }),
    );
    loadToolOfferOverrides({ "mcp__tavily__search": true });
    setToolOfferAutoBaseline(["mcp__tavily__search", "read_file"]);
    const always = resolveAlwaysOfferedToolNames();
    assert.equal(always.has("mcp__tavily__search"), false);
    assert.equal(isEagerTool("mcp__tavily__search"), false);
    assert.ok(deferredNameSet().has("mcp__tavily__search"));
    const pred = createOfferToolPredicate();
    assert.equal(pred("mcp__tavily__search"), false);
    assert.equal(pred("search_tools"), true);
    assert.equal(pred("tool_call"), true);
  });

  it("ignores stale MCP Include overrides on load", () => {
    clearToolOfferStateForTests();
    loadToolOfferOverrides({
      "mcp__x__y": true,
      read_file: true,
    });
    const always = resolveAlwaysOfferedToolNames();
    assert.equal(always.has("mcp__x__y"), false);
  });

  it("listDeferredToolNames excludes eager forced metas", () => {
    clearToolOfferStateForTests();
    const deferred = listDeferredToolNames();
    assert.equal(deferred.includes("search_tools"), false);
    assert.equal(deferred.includes("tool_describe"), false);
    assert.equal(deferred.includes("tool_call"), false);
  });
});

describe("tool bridge scope", () => {
  it("denylist wins; unset allowlist is open", () => {
    assert.equal(isBridgeInScope("read_file", undefined), true);
    assert.equal(
      isBridgeInScope("write_file", { denylist: new Set(["write_file"]) }),
      false,
    );
    assert.equal(
      isBridgeInScope("read_file", {
        allowlist: new Set(["grep"]),
        denylist: new Set(),
      }),
      false,
    );
  });
});

describe("subagent bridge scope", () => {
  it("explore denies write/shell but allows MCP via bridge", () => {
    assert.equal(isToolAllowedForSubagent("write_file", "explore"), false);
    assert.equal(isToolAllowedForSubagent("run_shell", "explore"), false);
    assert.equal(
      isToolAllowedForSubagent("mcp__tavily__search", "explore"),
      true,
    );
    assert.equal(
      isEagerToolAllowedForSubagent("mcp__tavily__search", "explore"),
      false,
    );
    assert.equal(isEagerToolAllowedForSubagent("read_file", "explore"), true);
    assert.equal(isEagerToolAllowedForSubagent("search_tools", "explore"), true);
    assert.equal(isEagerToolAllowedForSubagent("tool_call", "explore"), true);
    assert.equal(isEagerToolAllowedForSubagent("write_file", "explore"), false);
  });

  it("general allows MCP via bridge and write eagerly", () => {
    assert.equal(isToolAllowedForSubagent("mcp__x__y", "general"), true);
    assert.equal(isEagerToolAllowedForSubagent("mcp__x__y", "general"), false);
    assert.equal(isEagerToolAllowedForSubagent("write_file", "general"), true);
    assert.equal(isToolAllowedForSubagent("ask_user", "general"), false);
    assert.equal(isToolAllowedForSubagent("search_tools", "general"), true);
    const scope = bridgeScopeForSubagent("explore");
    assert.ok(scope.denylist?.has("write_file"));
    assert.equal(scope.denylist?.has("mcp__tavily__search"), false);
  });
});
