import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { responsesInputFromMessages } from "./wire.js";
import type { OpenAiChatMessage } from "../../types.js";

describe("responsesInputFromMessages tool-role images", () => {
  it("array tool content maps to function_call_output parts (probe-verified shape)", () => {
    const messages: OpenAiChatMessage[] = [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "[Image attached in this tool result]" },
          {
            type: "image_url",
            image_url: { url: "https://bucket.example/j/a.png" },
          },
        ],
      },
    ];
    const input = responsesInputFromMessages(messages, "scope-a");
    assert.deepEqual(input, [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "text", text: "[Image attached in this tool result]" },
          { type: "image_url", image_url: { url: "https://bucket.example/j/a.png" } },
        ],
      },
    ]);
  });

  it("string tool content keeps the plain string output", () => {
    const messages: OpenAiChatMessage[] = [
      { role: "tool", tool_call_id: "call_2", content: "ok" },
    ];
    const input = responsesInputFromMessages(messages, "scope-a");
    assert.deepEqual(input, [
      { type: "function_call_output", call_id: "call_2", output: "ok" },
    ]);
  });
});
