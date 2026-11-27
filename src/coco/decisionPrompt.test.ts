import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionPromptFor } from "./decisionPrompt.js";

describe("decisionPromptFor", () => {
  it("keeps an explicit open-ended ask_user prompt", () => {
    const prompt = decisionPromptFor("Describe the release note.", {
      question: "What should the release note say?",
      options: [],
      allowCustom: true,
    });
    assert.deepEqual(prompt.options, []);
    assert.equal(prompt.question, "What should the release note say?");
    assert.equal(prompt.allowCustom, true);
  });

  it("keeps supplied options from an escalated ask_user question", () => {
    const prompt = decisionPromptFor("Which parser?", {
      question: "Which parser should we keep?",
      options: ["Reuse the existing parser", "Rewrite it"],
      allowCustom: false,
    });
    assert.deepEqual(prompt.options, ["Reuse the existing parser", "Rewrite it"]);
    assert.equal(prompt.allowCustom, false);
    assert.equal(prompt.question, "Which parser should we keep?");
  });

  it("derives repair and recovery choices from the waiting reason", () => {
    assert.ok(decisionPromptFor("Automatic repair limit reached. Fail: missing file").options.includes("Try a different approach"));
    assert.ok(decisionPromptFor("Automatic recovery limit reached. Review the saved task").options.includes("Resume from the saved session"));
  });

  it("falls back to continue / pause / cancel for open-ended decisions", () => {
    assert.deepEqual(decisionPromptFor("Pick a product direction for the release.").options, [
      "Continue as planned",
      "Pause this work",
      "Cancel this work",
    ]);
  });
});
