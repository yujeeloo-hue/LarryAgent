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
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.enableReasoning, false);
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.temperature, undefined);
    assert.equal(body.stream, false);
  });

  it("TokenLink: sends only no_think (no low / thinking / enableReasoning)", async () => {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captureBody(init);
      return okResponse("feat: add tokenlink provider");
    }) as typeof fetch;

    await generateCommitMessage({
      workspacePath: "/tmp/repo",
      context: CONTEXT,
      client: {
        ...CLIENT,
        baseUrl: "https://tokenlink.woa.com/openapi/v1",
        model: "hy4",
      },
    });

    const body = capturedBodies[0];
    assert.ok(body);
    assert.equal(body.reasoning_effort, "no_think");
    assert.equal("thinking" in body, false);
    assert.equal("enableReasoning" in body, false);
    assert.equal(body.temperature, undefined);
  });

  it("falls back on a model error without retrying", async () => {
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
