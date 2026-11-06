/**
 * Commit-message generation must send reasoning-disable fields and never set
 * a temperature: Kimi K-series models forbid it outright (docs: temperature
 * must not be set; servers 400 with "only 1 / only 0.6 is allowed").
 * Also covers the source flag the commit card hints on.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { generateCommitMessage } from "./generateCommitMessage.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import type { CommitContext } from "./types.js";

const originalFetch = globalThis.fetch;

const CLIENT: OpenAiCompatibleClientConfig = {
  baseUrl: "https://api.moonshot.cn/v1",
  apiKey: "test-key",
  model: "kimi-k3",
};

const CONTEXT: CommitContext = {
  status: "M src/a.ts\nM src/b.ts\nM src/c.ts",
  diff: "",
  dirtyFileCount: 3,
  insertions: 10,
  deletions: 2,
};

const capturedBodies: Array<Record<string, unknown>> = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  capturedBodies.length = 0;
});

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(message: string): Response {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

function captureBody(init?: RequestInit): void {
  capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe("generateCommitMessage", () => {
  it("sends thinking-disable fields without forcing a temperature", async () => {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captureBody(init);
      return okResponse("feat: add export flow");
    }) as typeof fetch;

    const result = await generateCommitMessage({
      workspacePath: "/tmp/repo",
      context: CONTEXT,
      client: CLIENT,
    });

    assert.equal(result.source, "llm");
    assert.equal(result.message, "feat: add export flow");

    const body = capturedBodies[0];
    assert.ok(body);
    // Moonshot host falls into the double-write branch of noReasoningExtraBody.
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.enableReasoning, false);
    assert.equal(body.reasoning_effort, "low");
    // No forced temperature — provider default always passes the mode gate.
    assert.equal(body.temperature, undefined);
    assert.equal(body.stream, false);
  });

  it("falls back on a model error without retrying", async () => {
    // No temperature is ever sent; a 400 is final → fallback message.
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captureBody(init);
      assert.equal(capturedBodies.at(-1)?.temperature, undefined);
      return errorResponse(
        "invalid temperature: only 0.6 is allowed for this model",
      );
    }) as typeof fetch;

    const result = await generateCommitMessage({
      workspacePath: "/tmp/repo",
      context: CONTEXT,
      client: CLIENT,
    });

    assert.equal(result.source, "fallback");
    assert.equal(result.message, "Update 3 files");
    assert.equal(capturedBodies.length, 1);
  });

  it("reports the fallback source when the model rejects the request", async () => {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captureBody(init);
      return errorResponse("insufficient balance");
    }) as typeof fetch;

    const result = await generateCommitMessage({
      workspacePath: "/tmp/repo",
      context: CONTEXT,
      client: CLIENT,
    });

    assert.equal(result.source, "fallback");
    assert.equal(result.message, "Update 3 files");
  });

  it("returns fallback for empty status without calling the model", async () => {
    globalThis.fetch = originalFetch;
    const result = await generateCommitMessage({
      workspacePath: "/tmp/repo",
      context: { ...CONTEXT, status: "  " },
      client: CLIENT,
    });

    assert.equal(result.source, "fallback");
    assert.equal(result.message, "Update 3 files");
  });
});
