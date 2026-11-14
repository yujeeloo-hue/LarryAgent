import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  sanitizeInlineCompletion,
  shouldRequestCompletion,
  sliceCompletionWindow,
} from "./inlineCompletion.js";
import { streamChatCompletion } from "./openaiCompatibleClient.js";
import { runInlineCompletion } from "./runInlineCompletion.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sliceCompletionWindow", () => {
  it("skips a caret inside an identifier", () => {
    assert.equal(shouldRequestCompletion("foo", "Bar"), false);
    assert.equal(sliceCompletionWindow("const fooBar = 1", 7), null);
  });

  it("keeps a caret at the end of a line", () => {
    const window = sliceCompletionWindow("const name = \n}", 13);
    assert.ok(window);
    assert.equal(window.prefix, "const name = ");
    assert.equal(window.suffix, "\n}");
  });

  it("cuts a long prefix on a newline", () => {
    const head = `${"x".repeat(7000)}\n`;
    const tail = "const value = ";
    const text = `${head}${tail}`;
    const window = sliceCompletionWindow(text, text.length);
    assert.ok(window);
    assert.equal(window.prefix.startsWith("x"), false);
    assert.equal(window.prefix, tail);
  });
});

describe("sanitizeInlineCompletion", () => {
  it("strips a repeated prefix and a closing brace the file already has", () => {
    const text = sanitizeInlineCompletion(
      "const name = 1;\n}",
      "const name = ",
      "\n}",
    );
    assert.equal(text, "1;");
  });

  it("unwraps a markdown fence and rejects prose", () => {
    assert.equal(
      sanitizeInlineCompletion("```ts\nreturn 1;\n```", "  ", "\n"),
      "return 1;",
    );
    assert.equal(
      sanitizeInlineCompletion("Here is the completed line: return 1;", "  ", "\n"),
      null,
    );
  });

  it("stays on one line when the caret is mid-line", () => {
    assert.equal(
      sanitizeInlineCompletion("1;\nreturn 2;", "const name = ", " + 1"),
      "1;",
    );
  });

  it("does not suggest text that is already the suffix", () => {
    assert.equal(sanitizeInlineCompletion("}", "if (ok) {\n", "}"), null);
  });
});

function sse(content: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
}

describe("runInlineCompletion", () => {
  const client = {
    baseUrl: "https://inline.example/v1",
    apiKey: "k",
    model: "m",
  };

  it("returns the insertion from a short stream", async () => {
    globalThis.fetch = (async () =>
      new Response(sse("return 1;"), {
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch;
    const text = await runInlineCompletion({
      client,
      prefix: "function f() {\n  ",
      suffix: "\n}",
      languageId: "typescript",
      fileName: "f.ts",
      firstTokenMs: 1_000,
      totalMs: 2_000,
    });
    assert.equal(text, "return 1;");
  });

  it("shows nothing when the first token misses the deadline", async () => {
    globalThis.fetch = (async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      return new Response(sse("late"), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    const text = await runInlineCompletion({
      client,
      prefix: "const name = ",
      suffix: "\n",
      languageId: "typescript",
      fileName: "f.ts",
      firstTokenMs: 30,
      totalMs: 200,
    });
    assert.equal(text, null);
  });
});

describe("stream maxAttempts", () => {
  it("does not retry an inline completion", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const events = [];
    for await (const event of streamChatCompletion(
      { baseUrl: "https://inline.example/v1", apiKey: "k", model: "m" },
      {
        messages: [{ role: "user", content: "hi" }],
        maxAttempts: 1,
        timeoutMs: 1_000,
      },
    )) {
      events.push(event);
    }
    assert.equal(calls, 1);
    assert.equal(events.at(-1)?.type, "done");
  });
});
