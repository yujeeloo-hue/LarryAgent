/**
 * Hosted tool family helpers (web console Token Hub editor) — desktop
 * setResponsesToolEnabled parity: enabling preserves configured advanced
 * options, disabling removes exactly that family, and the JSON textarea
 * validation mirrors validateResponsesTools.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HOSTED_TOOL_FAMILIES,
  normalizeToolsArray,
  parseHostedToolsJson,
  setToolEnabled,
  toolEnabled,
} from "../src/hostedTools.js";

const CODE = { type: "code_interpreter", container: { type: "auto" } };

test("normalizeToolsArray drops malformed entries", () => {
  assert.deepEqual(normalizeToolsArray([{ type: "web_search" }, null, 3, [], { type: " " }, { no: "type" }]), [
    { type: "web_search" },
  ]);
  assert.deepEqual(normalizeToolsArray(undefined), []);
  assert.deepEqual(normalizeToolsArray("nope"), []);
});

test("enabling a family preserves existing advanced definitions", () => {
  const tools = [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }, CODE];
  // Already configured → untouched.
  assert.deepEqual(setToolEnabled(tools, "web_search", true), tools);
  // New family → default definition appended.
  const next = setToolEnabled(tools, "image_generation", true);
  assert.deepEqual(next.at(-1), { type: "image_generation" });
  assert.equal(next.length, 3);
});

test("disabling removes exactly the family, including web_search_preview", () => {
  const tools = [
    { type: "web_search_preview", search_context_size: "high" },
    CODE,
    { type: "file_search", vector_store_ids: ["vs-1"] },
  ];
  const next = setToolEnabled(tools, "web_search", false);
  assert.deepEqual(next, [CODE, { type: "file_search", vector_store_ids: ["vs-1"] }]);
  assert.equal(toolEnabled(next, "web_search"), false);
  assert.equal(toolEnabled(next, "code_interpreter"), true);
});

test("code_interpreter default carries container auto (desktop parity)", () => {
  assert.deepEqual(setToolEnabled([], "code_interpreter", true), [CODE]);
  assert.deepEqual(setToolEnabled([], "web_search", true), [{ type: "web_search" }]);
  assert.equal(HOSTED_TOOL_FAMILIES.length, 3);
});

test("parseHostedToolsJson mirrors desktop validation", () => {
  assert.deepEqual(parseHostedToolsJson(""), { ok: true, tools: [] });
  assert.deepEqual(parseHostedToolsJson('[{"type":"mcp"}]'), { ok: true, tools: [{ type: "mcp" }] });
  assert.equal(parseHostedToolsJson("{").ok, false);
  assert.match((parseHostedToolsJson("{") as { error: string }).error, /valid JSON/);
  assert.equal(parseHostedToolsJson('{"type":"web_search"}').ok, false);
  assert.equal(parseHostedToolsJson('[42]').ok, false);
  assert.equal(parseHostedToolsJson('[{"type":""}]').ok, false);
  assert.equal(parseHostedToolsJson('["x"]').ok, false);
  // parsed tools are deep copies — mutating them cannot leak into the input.
  const parsed = parseHostedToolsJson('[{"type":"web_search","filters":{"a":1}}]');
  assert.ok(parsed.ok);
  parsed.tools[0]!.filters!.a = 2;
  const reparsed = parseHostedToolsJson('[{"type":"web_search","filters":{"a":1}}]');
  assert.ok(reparsed.ok);
  assert.equal(reparsed.tools[0]!.filters!.a, 1);
});
