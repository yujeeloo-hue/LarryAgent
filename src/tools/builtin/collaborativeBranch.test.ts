import assert from "node:assert/strict";
import test from "node:test";
import { configureCollaborativePort } from "../../collaborative/port.js";
import { collaborativeBranchHandler } from "./collaborativeBranch.js";
import type { ToolExecuteContext } from "../types.js";

test("collaborative tools retain the session workspace and cannot change bindings", async () => {
  const context = { workspacePath: "E:/NF" } as ToolExecuteContext;
  let calls = 0;
  configureCollaborativePort(async request => {
    calls++;
    assert.equal(request.workspacePath, context.workspacePath);
    assert.equal(request.op, "read");
    assert.equal(request.repositoryId, "engine");
    return { paths: ["Source/test.cpp"] };
  });
  await collaborativeBranchHandler({ op: "read", workspacePath: "E:/Other", repositoryId: "engine", path: "Source/test.cpp" }, context);
  assert.equal(calls, 1);
  await collaborativeBranchHandler({ op: "bind", branch: "main" }, context);
  assert.equal(calls, 1);
  assert.equal(context.workspacePath, "E:/NF");
});
