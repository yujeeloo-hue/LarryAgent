import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "../../../../session/types.js";
import type { ProtectIteration } from "./splitIterations.js";
import {
  ROUND_PROTECT_REASONING_MAX_CHARS,
  clipReasoningForSummary,
  reasoningFromMessage,
  serializeIterationsForSummary,
} from "./serializeForSummary.js";

function assistant(parts: Message["parts"]): Message {
  return {
    id: "a1",
    role: "assistant",
    parts,
    createdAt: 1,
  };
}

function iterationWith(messages: Message[]): ProtectIteration {
  return {
    age: 1,
    chronoIndex: 0,
    userPrefix: [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Please refactor" }],
        createdAt: 0,
      },
    ],
    messages,
    tokens: 10,
  };
}

describe("serializeIterationsForSummary reasoning", () => {
  it("includes clipped [reasoning] in ASSISTANT block", () => {
    const text = serializeIterationsForSummary([
      iterationWith([
        assistant([
          {
            type: "reasoning",
            text: "Use StrReplace instead of rewriting the whole file.",
            providerScope: "summary-client",
          },
          { type: "text", text: "I'll edit the file." },
        ]),
      ]),
    ], { reasoningScope: "summary-client" });
    assert.match(text, /\[ASSISTANT\]:/);
    assert.match(text, /\[reasoning\]:/);
    assert.match(text, /Use StrReplace/);
    assert.match(text, /I'll edit the file/);
  });

  it("keeps legacy reasoning out of summarize payloads when its binding is unknown", () => {
    const text = serializeIterationsForSummary([
      iterationWith([
        assistant([
          { type: "reasoning", text: "Need absolute workspace path." },
        ]),
      ]),
    ], { reasoningScope: "summary-client" });
    assert.doesNotMatch(text, /\[reasoning\]|Need absolute workspace path/);
  });

  it("clips oversized reasoning with head+tail mark", () => {
    const long = `HEAD_MARKER_${"x".repeat(ROUND_PROTECT_REASONING_MAX_CHARS)}_TAIL_MARKER`;
    const clipped = clipReasoningForSummary(long);
    assert.ok(clipped.length < long.length);
    assert.match(clipped, /HEAD_MARKER_/);
    assert.match(clipped, /_TAIL_MARKER/);
    assert.match(clipped, /truncated/);
  });

  it("reasoningFromMessage ignores empty reasoning parts", () => {
    const msg = assistant([
      { type: "reasoning", text: "   ", providerScope: "summary-client" },
      { type: "reasoning", text: "Real rationale.", providerScope: "summary-client" },
      { type: "reasoning", text: "Foreign rationale.", providerScope: "other-client" },
      { type: "text", text: "Hi" },
    ]);
    assert.equal(reasoningFromMessage(msg, "summary-client"), "Real rationale.");
    assert.equal(reasoningFromMessage(msg), "");
  });

  it("excludes even scoped reasoning when no summary binding was supplied", () => {
    const text = serializeIterationsForSummary([iterationWith([assistant([
      { type: "reasoning", text: "Private rationale.", providerScope: "summary-client" },
      { type: "text", text: "Public result." },
    ])])]);
    assert.match(text, /Public result\./);
    assert.doesNotMatch(text, /Private rationale|\[reasoning\]/);
  });
});
