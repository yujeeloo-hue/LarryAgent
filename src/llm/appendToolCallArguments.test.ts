import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendToolCallArguments,
  toolCallArgumentsDeltaToString,
} from "./appendToolCallArguments.js";

describe("appendToolCallArguments", () => {
  it("concatenates OpenAI-style JSON fragments", () => {
    const a = appendToolCallArguments("", '{"path":"/x","content":"hel');
    const b = appendToolCallArguments(a, 'lo"}');
    assert.equal(b, '{"path":"/x","content":"hello"}');
  });

  it("concatenates after a lone opening brace (OpenAI first bytes)", () => {
    const a = appendToolCallArguments("", "{");
    const b = appendToolCallArguments(a, '"path":"/x"}');
    assert.equal(b, '{"path":"/x"}');
  });

  it("replaces GLM-style full argument snapshots instead of concatenating", () => {
    const first = '{"path":"/x","content":""}';
    const second = '{"path":"/x","content":"hello\\nworld"}';
    assert.equal(appendToolCallArguments(first, second), second);
  });

  it("replaces unclosed GLM growing snapshots so they cannot stack", () => {
    const a = appendToolCallArguments("", '{"path":"/x","content":"');
    const b = appendToolCallArguments(a, '{"path":"/x","content":"hel');
    const c = appendToolCallArguments(b, '{"path":"/x","content":"hello"}');
    assert.equal(b, '{"path":"/x","content":"hel');
    assert.equal(c, '{"path":"/x","content":"hello"}');
    assert.ok(!c.includes('{"path":"/x","content":"hel{"'));
  });

  it("keeps a nested arguments object (tool_call bridge fragments)", () => {
    const frames = [
      '{"arguments":',
      '{"scope": "active"}',
      ',"name":"mcp__jnote__list_notes"}',
    ];
    const merged = frames.reduce(
      (acc, frame) => appendToolCallArguments(acc, frame),
      "",
    );
    assert.deepEqual(JSON.parse(merged), {
      arguments: { scope: "active" },
      name: "mcp__jnote__list_notes",
    });
  });

  it("keeps write_file content whose fragment opens a brace", () => {
    const frames = ['{"path":"/x.md","content":"config: ', '{\\"a\\":1}', '"}'];
    const merged = frames.reduce(
      (acc, frame) => appendToolCallArguments(acc, frame),
      "",
    );
    assert.deepEqual(JSON.parse(merged), {
      path: "/x.md",
      content: 'config: {"a":1}',
    });
  });

  it("replaces empty-object then real snapshot (get_current_time style)", () => {
    assert.equal(appendToolCallArguments("{}", "{}"), "{}");
    assert.equal(
      appendToolCallArguments("{}", '{"path":"/x"}'),
      '{"path":"/x"}',
    );
  });
});

describe("toolCallArgumentsDeltaToString", () => {
  it("stringifies object payloads some gateways emit", () => {
    assert.equal(
      toolCallArgumentsDeltaToString({ path: "/x", content: "a" }),
      '{"path":"/x","content":"a"}',
    );
  });
});
