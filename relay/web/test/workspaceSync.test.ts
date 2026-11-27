import test from "node:test";
import assert from "node:assert/strict";

import {
  deviceProjectIds,
  isWorkspaceMutationTool,
} from "../src/workspaceSync.js";
import type { SessionSummary } from "../src/types.js";

function session(id: string, workspaceId: string): SessionSummary {
  return {
    id,
    title: id,
    updatedAt: 0,
    status: "idle",
    progressText: "",
    type: "agent",
    messageCount: 0,
    archived: false,
    archivedAt: null,
    ...({ workspaceId } as Partial<SessionSummary>),
  } as SessionSummary;
}

test("workspace mutation tools trigger a workspace list refresh", () => {
  assert.equal(isWorkspaceMutationTool("create_workspace"), true);
  assert.equal(isWorkspaceMutationTool("rename_workspace"), true);
  assert.equal(isWorkspaceMutationTool("write_file"), false);
  assert.equal(isWorkspaceMutationTool(undefined), false);
});

test("registered workspaces with no sessions still appear as projects", () => {
  const ids = deviceProjectIds(
    [session("s1", "with-session")],
    new Map([
      ["with-session", "With session"],
      ["empty", "Empty"],
    ]),
    [{ id: "with-session" }, { id: "empty" }],
  );
  assert.deepEqual(ids, ["with-session", "empty"]);
});

test("stale session workspace ids are excluded when the device has a workspace list", () => {
  const ids = deviceProjectIds(
    [session("s1", "stale"), session("s2", "known")],
    new Map([["known", "Known"]]),
    [{ id: "known" }],
  );
  assert.deepEqual(ids, ["known"]);
});
