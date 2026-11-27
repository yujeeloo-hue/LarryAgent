import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildConversationTextForTitle,
  fitConversationForTitle,
  sanitizeSessionTitle,
} from "./generateTitle.js";

describe("session title English requirement", () => {
  it("prompt file requires English titles from this turn", () => {
    const prompt = readFileSync(
      join(process.cwd(), "resources/prompts/session-title.md"),
      "utf8",
    );
    assert.match(prompt, /Always write the title in English/i);
    assert.match(prompt, /this turn/i);
    assert.doesNotMatch(prompt, /Prefer the same language/i);
    assert.doesNotMatch(prompt, /conversation so far/i);
  });

  it("sanitize still accepts English titles", () => {
    assert.equal(
      sanitizeSessionTitle("Refactor auth middleware"),
      "Refactor auth middleware",
    );
  });

  it("rejects echoed USER PROMPT scaffolding", () => {
    assert.equal(sanitizeSessionTitle("## USER PROMPT"), null);
    assert.equal(sanitizeSessionTitle("USER PROMPT"), null);
    assert.equal(
      sanitizeSessionTitle("## USER PROMPT\nWrite a cheerful song"),
      "Write a cheerful song",
    );
  });

  it("buildConversationTextForTitle keeps users and stubs tool results", () => {
    const text = buildConversationTextForTitle([
      {
        id: "u1",
        role: "user",
        createdAt: 1,
        parts: [{ type: "text", text: "Add SVG support" }],
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: 2,
        parts: [
          { type: "text", text: "I'll look into it." },
          {
            type: "tool_call",
            id: "c1",
            name: "read_file",
            status: "done",
            arguments: {},
            argumentsRaw: "{}",
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "c1",
        createdAt: 3,
        parts: [
          {
            type: "tool_result",
            toolCallId: "c1",
            returnCode: 0,
            content: [{ type: "text", text: "huge body ".repeat(100) }],
          },
        ],
      },
    ]);
    assert.match(text, /Add SVG support/);
    assert.match(text, /\[assistant\]/);
    assert.match(text, /\[tool_call read_file\]/);
    assert.match(text, /\[tool_result rc=0\]/);
    assert.doesNotMatch(text, /huge body/);
  });

  it("fitConversationForTitle keeps head and tail when oversized", () => {
    const fitted = fitConversationForTitle(
      "A".repeat(100) + "MID" + "B".repeat(100),
      50,
    );
    assert.ok(fitted.length <= 50);
    assert.match(fitted, /^A+/);
    assert.match(fitted, /B+$/);
    assert.match(fitted, /…/);
  });
});
