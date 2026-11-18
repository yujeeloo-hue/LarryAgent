import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToolApproval, requiresUserApproval, toolApprovalQuestion } from "./toolApproval.js";

describe("supervisory tool approvals", () => {
  it("only fatal Shell findings are reserved for the user", () => {
    assert.equal(requiresUserApproval({ toolName: "run_shell", arguments: {}, risk: { fatal: true, reason: "Formats a disk", trashRewrite: false } }), true);
    assert.equal(requiresUserApproval({ toolName: "run_shell", arguments: {}, risk: { fatal: false, reason: "Force push", trashRewrite: false } }), false);
    assert.equal(requiresUserApproval({ toolName: "mcp__x__y", arguments: {}, source: "ask_level" }), false);
  });

  it("question carries tool, source, risk, Trash note, goal and clipped arguments", () => {
    const q = toolApprovalQuestion({
      toolName: "run_shell",
      arguments: { command: `git push --force ${"x".repeat(4000)}` },
      risk: { fatal: false, reason: "Force push rewrites remote history.", trashRewrite: true },
      source: "shell_risk",
    }, "Ship the relay fix");
    assert.match(q, /^Tool approval: .*"run_shell"/);
    assert.match(q, /Shell Safe Mode flagged/);
    assert.match(q, /Risk: Force push rewrites remote history\./);
    assert.match(q, /move to the Trash/);
    assert.match(q, /Saved goal: Ship the relay fix/);
    assert.ok(q.length < 3500, "arguments are clipped");
  });

  it("source defaults: risk → Shell, none → Ask level; hook asks are named", () => {
    assert.match(toolApprovalQuestion({ toolName: "t", arguments: {} }), /ask before every run/);
    assert.match(toolApprovalQuestion({ toolName: "t", arguments: {}, source: "hook_ask" }), /hook asked/);
  });

  it("parses Approve / Deny and treats everything else as needs-user", () => {
    assert.equal(parseToolApproval({ action: "answer", answer: "Approve" }), true);
    assert.equal(parseToolApproval({ action: "answer", selections: ["Deny"] }), false);
    assert.equal(parseToolApproval({ action: "answer", answer: "Maybe" }), "needs-user");
    assert.equal(parseToolApproval({ action: "needs_user", answer: "Approve" }), "needs-user");
    assert.equal(parseToolApproval(undefined), "needs-user");
  });
});
