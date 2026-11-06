import assert from "node:assert/strict";
import { before, test } from "node:test";
import { registerBuiltins } from "./index.js";
import { listToolCatalog } from "./catalogService.js";
import { toolsToOpenAi } from "../agent/toolsToOpenAi.js";

before(() => registerBuiltins());

test("management summaries are human copy while model definitions remain unchanged", () => {
  const modelTools = toolsToOpenAi();
  const entries = listToolCatalog();
  assert.ok(entries.length > 40);
  for (const entry of entries) {
    assert.ok(entry.displayDescription.length > 10 && entry.displayDescription.length < 140, entry.name);
    assert.doesNotMatch(entry.displayDescription, /\n|required|parameters|timeoutMs|action=/i, entry.name);
    assert.equal(entry.description, modelTools.find(tool=>tool.function.name===entry.name)?.function.description, entry.name);
  }
  assert.equal(entries.find(tool=>tool.name==="dispatch_subagent")?.displayDescription, "Assign part of the task to another agent.");
  const devTasks = entries.find(tool=>tool.name==="dev_tasks")!;
  assert.notEqual(devTasks.description, devTasks.displayDescription);
  assert.match(devTasks.description, /action=get/);
  assert.deepEqual(toolsToOpenAi(), modelTools);
});
