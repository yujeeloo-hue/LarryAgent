/**
 * /opt prompt optimization (docs/plans/20260828-composer-prompt-optimizer.md):
 * sanitizer branches + one-shot call wiring (reasoning disabled via
 * noReasoningExtraBody (no forced temperature), 10s wall-clock cap).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  PROMPT_OPTIMIZE_TIMEOUT_MS,
  optimizeUserPromptOnce,
  sanitizeOptimizedPrompt,
} from "./optimizePrompt.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";

const originalFetch = globalThis.fetch;

const CLIENT: OpenAiCompatibleClientConfig = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "k",
  model: "deepseek-test",
};

type CapturedRequest = { url: string; body: Record<string, unknown> };

function installCapturingFetch(content: string): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sanitizeOptimizedPrompt", () => {
  it("passes clean text through unchanged", () => {
    assert.equal(sanitizeOptimizedPrompt("已修正的句子", "原始"), "已修正的句子");
  });

  it("rejects empty output", () => {
    assert.equal(sanitizeOptimizedPrompt("", "原始"), null);
    assert.equal(sanitizeOptimizedPrompt("   \n  ", "原始"), null);
  });

  it("strips a whole-message markdown fence", () => {
    assert.equal(
      sanitizeOptimizedPrompt("```text\nfixed text\n```", "orig"),
      "fixed text",
    );
  });

  it("strips a scaffold label prefix", () => {
    assert.equal(
      sanitizeOptimizedPrompt("Optimized prompt: fixed", "orig"),
      "fixed",
    );
    assert.equal(
      sanitizeOptimizedPrompt("Optimized prompt:\n\nfixed", "orig"),
      "fixed",
    );
  });

  it("strips one layer of wrapping quotes", () => {
    assert.equal(sanitizeOptimizedPrompt('"fixed"', "orig"), "fixed");
    assert.equal(sanitizeOptimizedPrompt("“fixed”", "orig"), "fixed");
  });

  it("handles fence + label + quotes combined", () => {
    assert.equal(
      sanitizeOptimizedPrompt('```\nOptimized prompt:\n\n"fixed"\n```', "orig"),
      "fixed",
    );
  });

  it("rejects runaway rewrites via the length guard", () => {
    const original = "hi";
    const runaway = "x".repeat(original.length * 3 + 201);
    assert.equal(sanitizeOptimizedPrompt(runaway, original), null);
    // Just under the guard passes.
    const edge = "x".repeat(original.length * 3 + 200);
    assert.equal(sanitizeOptimizedPrompt(edge, original), edge);
  });
});

describe("optimizeUserPromptOnce", () => {
  it("returns the sanitized text and wires the fast-pass body", async () => {
    const captured = installCapturingFetch('```text\n"修正后的句子"\n```');
    const result = await optimizeUserPromptOnce({
      text: "原始句子",
      client: CLIENT,
    });
    assert.equal(result, "修正后的句子");
    assert.equal(captured.length, 1);
    const request = captured[0];
    assert.ok(request);
    const body = request.body;
    assert.equal(body.model, "deepseek-test");
    // noReasoningExtraBody on a DeepSeek host: thinking disabled.
    const thinking = body.thinking as { type?: string } | undefined;
    assert.equal(thinking?.type, "disabled");
    // No forced temperature — Kimi docs forbid setting it; provider default only.
    assert.equal(body.temperature, undefined);
    const messages = body.messages as Array<{ role: string; content: string }>;
    assert.equal(messages.length, 2);
    const [systemMessage, userMessage] = messages;
    assert.ok(systemMessage && userMessage);
    assert.equal(systemMessage.role, "system");
    assert.match(systemMessage.content, /coding agent/);
    assert.match(systemMessage.content, /exactly as written/);
    assert.equal(userMessage.role, "user");
    assert.equal(userMessage.content, "原始句子");
  });

  it("returns null on request failure without throwing", async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const result = await optimizeUserPromptOnce({
      text: "原始句子",
      client: CLIENT,
    });
    assert.equal(result, null);
  });

  it("returns null when the output fails sanitization", async () => {
    installCapturingFetch("x".repeat(3 * 2 + 201));
    const result = await optimizeUserPromptOnce({
      text: "原始",
      client: CLIENT,
    });
    assert.equal(result, null);
  });

  it("short-circuits empty input without a request", async () => {
    let called = false;
    globalThis.fetch = (async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    assert.equal(
      await optimizeUserPromptOnce({ text: "   ", client: CLIENT }),
      null,
    );
    assert.equal(called, false);
  });

  it("exports the 10s wall-clock cap", () => {
    assert.equal(PROMPT_OPTIMIZE_TIMEOUT_MS, 10_000);
  });
});
