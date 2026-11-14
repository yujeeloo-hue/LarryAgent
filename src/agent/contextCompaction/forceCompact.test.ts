/**
 * /compact force semantics: with force=true the compactTriggerRatio gate is
 * skipped, so a below-threshold session still compacts. Without force the
 * same session stays untouched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message, Session } from "../../session/types.js";
import { getCompactionStrategy } from "./registry.js";
import type {
  CompactBeforeIterationInput,
  CompactContextResult,
} from "./types.js";

function transcript(): Message[] {
  const messages: Message[] = [];
  for (let i = 1; i <= 4; i++) {
    messages.push({
      id: `u${i}`,
      role: "user",
      parts: [{ type: "text", text: `Request number ${i}` }],
      createdAt: i,
    });
    messages.push({
      id: `a${i}`,
      role: "assistant",
      parts: [
        { type: "text", text: `Answer ${i}: did the thing you asked for.` },
      ],
      createdAt: i + 1,
    });
  }
  return messages;
}

function makeSession(): Session {
  const now = Date.now();
  return {
    id: "force-compact-sess",
    type: "agent",
    title: "Force compact test",
    createdAt: now,
    updatedAt: now,
    status: "completed",
    progressText: "",
    messages: transcript(),
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    planDoc: null,
  };
}

function makeInput(
  extra: Partial<CompactBeforeIterationInput>,
): CompactBeforeIterationInput {
  let id = 0;
  return {
    session: makeSession(),
    client: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      model: "mock-model",
    },
    createId: () => `c-${++id}`,
    // Huge limit → the ratio gate would always skip without force.
    contextLimitTokens: 1_000_000,
    summarize: async () => ({ content: "Summarized conversation." }),
    ...extra,
  };
}

function failOnError(result: CompactContextResult): void {
  if ("error" in result && typeof result.error === "string") {
    assert.fail(result.error);
  }
}

describe("iterationProtectV1 force compact", () => {
  it("skips a below-threshold session without force", async () => {
    const input = makeInput({ iterationProtectRawIterationCount: 1 });
    const result = await getCompactionStrategy(
      "iterationProtectV1",
    ).maybeCompactBeforeIteration(input);
    assert.equal(result.compacted, false);
    failOnError(result);
    assert.equal(input.session.messages.length, 8);
  });

  it("compacts a below-threshold session with force", async () => {
    const input = makeInput({
      iterationProtectRawIterationCount: 1,
      force: true,
    });
    const result = await getCompactionStrategy(
      "iterationProtectV1",
    ).maybeCompactBeforeIteration(input);
    assert.equal(result.compacted, true);
    failOnError(result);
    assert.ok(
      input.session.messages.some((message) =>
        message.parts.some((part) => part.type === "context_compaction"),
      ),
    );
  });
});

describe("/end digest semantics (iterationProtectV1, zero protect)", () => {
  it("folds everything with zero protection and force", async () => {
    const input = makeInput({
      iterationProtectRawIterationCount: 0,
      iterationProtectTokenRatio: 0,
      force: true,
      summarize: async () => ({ content: "Protect digest." }),
    });
    const result = await getCompactionStrategy(
      "iterationProtectV1",
    ).maybeCompactBeforeIteration(input);
    assert.equal(result.compacted, true);
    failOnError(result);
  });
});
