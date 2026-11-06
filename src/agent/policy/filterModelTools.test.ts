import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterModelTools } from "./filterModelTools.js";

const chatRead = { type: "function", function: { name: "read_file" } };
const chatWrite = { type: "function", function: { name: "write_file" } };
const responsesRead = { type: "function", name: "read_image" };
const search = { type: "web_search" };
const fileSearch = { type: "file_search" };
const code = { type: "code_interpreter", container: { type: "auto" } };
const github = { type: "mcp", server_label: "github", server_url: "https://example.com/github" };
const notion = { type: "mcp", server_label: "notion", server_url: "https://example.com/notion" };

describe("filterModelTools", () => {
  it("preserves unrestricted lists and object identity without mutating the input", () => {
    const tools = Object.freeze([chatRead, search, {}, null]);
    const filtered = filterModelTools(tools, {});
    assert.deepEqual(filtered, tools);
    assert.notEqual(filtered, tools);
    assert.equal(filtered[0], chatRead);
    assert.deepEqual(filterModelTools(tools, { allowTools: [], denyTools: [] }), tools);
  });

  it("filters nested Chat and flat Responses functions by their real names", () => {
    assert.deepEqual(filterModelTools([chatRead, chatWrite, responsesRead], {
      allowTools: ["read_*"],
    }), [chatRead, responsesRead]);
  });

  it("lets deny override an intersecting whitelist", () => {
    assert.deepEqual(filterModelTools([chatRead, chatWrite, responsesRead], {
      allowTools: ["read_*", "write_file"],
      denyTools: ["*_file"],
    }), [responsesRead]);
  });

  it("uses the existing exact and case-insensitive glob matching rules", () => {
    const mixed = { type: "function", name: "mcp__jnote__List_notes" };
    assert.deepEqual(filterModelTools([mixed], {
      allowTools: ["mcp__jnote__list_*"],
    }), [mixed]);
    assert.deepEqual(filterModelTools([mixed], {
      allowTools: ["mcp__jnote__list_notes"],
    }), []);
    assert.deepEqual(filterModelTools([mixed], { denyTools: ["MCP__JNOTE__*"] }), []);
  });

  it("filters native tools without names by their type", () => {
    assert.deepEqual(filterModelTools([search, fileSearch, code, chatRead], {
      denyTools: ["web_search", "code_*"],
    }), [fileSearch, chatRead]);
    assert.deepEqual(filterModelTools([search, fileSearch, code, chatRead], {
      allowTools: ["*_search"],
    }), [search, fileSearch]);
  });

  it("never substitutes a hosted tool name for its actual type", () => {
    const disguised = { type: "web_search", name: "read_file" };
    assert.deepEqual(filterModelTools([disguised], { allowTools: ["read_file"] }), []);
    assert.deepEqual(filterModelTools([disguised], { denyTools: ["web_search"] }), []);
  });

  it("supports explicitly allowing one MCP server or the entire MCP family", () => {
    assert.deepEqual(filterModelTools([github, notion, chatRead], {
      allowTools: ["github"],
    }), [github]);
    assert.deepEqual(filterModelTools([github, notion, chatRead], {
      allowTools: ["mcp"],
    }), [github, notion]);
  });

  it("denies all MCP servers by mcp even when an individual server is allowed", () => {
    assert.deepEqual(filterModelTools([github, notion], {
      allowTools: ["github"], denyTools: ["mcp"],
    }), []);
  });

  it("denies a single MCP server even when the MCP family is allowed", () => {
    assert.deepEqual(filterModelTools([github, notion], {
      allowTools: ["mcp"], denyTools: ["git*"],
    }), [notion]);
  });

  it("fails closed for unknown and ambiguous identities under either list", () => {
    const malformed: unknown[] = [
      null, undefined, [], "read_file", {}, { name: "read_file" },
      { type: "" }, { type: " web_search" },
      { type: "function" }, { type: "function", name: "" },
      { type: "function", function: { name: "read_file " } },
      { type: "function", name: "read_file", function: { name: "write_file" } },
      { type: "mcp" }, { type: "mcp", server_label: "" },
    ];
    assert.deepEqual(filterModelTools(malformed, { allowTools: ["*"] }), []);
    assert.deepEqual(filterModelTools(malformed, { denyTools: ["write_file"] }), []);
  });

  it("does not turn a function-type whitelist into permission for every function", () => {
    assert.deepEqual(filterModelTools([chatRead, responsesRead], { allowTools: ["function"] }), []);
  });

  it("returns an empty list for an empty tool set with any policy", () => {
    assert.deepEqual(filterModelTools([], { allowTools: ["*"], denyTools: ["*"] }), []);
  });
});
