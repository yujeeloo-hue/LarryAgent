import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isInterruptibleToolName } from "./interruptibleTools.js";

describe("isInterruptibleToolName (interrupt tool fork)", () => {
  it("shell family and read/search tools are interruptible", () => {
    for (const name of [
      "run_shell",
      "exec_command",
      "read_file",
      "read_image",
      "grep",
      "list_dir",
      "batch_search",
      "search_tools",
      "search_skills",
      "search_session_history",
    ]) {
      assert.equal(isInterruptibleToolName(name), true, name);
    }
  });

  it("write-class and unknown tools are NOT interruptible", () => {
    for (const name of [
      "patch",
      "write_file",
      "dispatch_subagent",
      "await_subagent",
      "update_user_memory",
      "update_project_memory",
      "create_skill",
      "upload_files",
      "ask_user",
      "totally_unknown_tool",
    ]) {
      assert.equal(isInterruptibleToolName(name), false, name);
    }
  });
});
