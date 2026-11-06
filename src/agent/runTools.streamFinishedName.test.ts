/**
 * tool_finished stream events must carry the finishing tool's name so the
 * conversation footer can refresh Commit/Changes git stats right after
 * write_file / edit_file / append_file results land (mid-turn, not at turn end).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type {
  StreamEvent,
  StreamToolFinishedEvent,
} from "../llm/streamEvents.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import type {
  JsonObject,
  Session,
  ToolCallPart,
} from "../session/types.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import type { PermissionGateState } from "../tools/types.js";
import { registerBuiltins } from "../tools/index.js";
import { runTools } from "./runTools.js";

let userDataDir = "";
let wsDir = "";

before(async () => {
  registerBuiltins();
  userDataDir = await mkdtemp(join(tmpdir(), "runtools-finished-"));
  configureUserMemoryRoot(userDataDir);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
  wsDir = await mkdtemp(join(tmpdir(), "runtools-finished-ws-"));
});

after(async () => {
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
  if (wsDir) {
    await rm(wsDir, { recursive: true, force: true });
  }
});

function makeSession(): Session {
  const now = Date.now();
  return {
    id: "runtools-finished-sess",
    type: "agent",
    title: "tool_finished name",
    createdAt: now,
    updatedAt: now,
    status: "running",
    progressText: "",
    messages: [],
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath: wsDir,
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    planDoc: null,
  };
}

function makeCall(
  id: string,
  name: string,
  args: JsonObject,
  argumentsRaw: string,
): ToolCallPart {
  return {
    type: "tool_call",
    id,
    name,
    status: "pending",
    arguments: args,
    argumentsRaw,
  };
}

function finishedEvents(events: StreamEvent[]): StreamToolFinishedEvent[] {
  return events.filter(
    (event): event is StreamToolFinishedEvent => event.type === "tool_finished",
  );
}

describe("runTools tool_finished name", () => {
  it("carries write_file on the success path", async () => {
    const session = makeSession();
    const events: StreamEvent[] = [];
    let n = 0;
    const args = { path: join(wsDir, "note.txt"), content: "hello" };
    const result = await runTools({
      session,
      assistantMessageId: "m-1",
      toolCalls: [makeCall("call-write-1", "write_file", args, JSON.stringify(args))],
      gate: { fullPermissionsEnabled: true } as PermissionGateState,
      createId: () => `id-${++n}`,
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.cancelled, false);
    assert.equal(result.toolFailureCount, 0, "write_file should succeed");

    const finished = finishedEvents(events);
    assert.equal(finished.length, 1);
    assert.ok(finished[0], "tool_finished present");
    assert.equal(finished[0].id, "call-write-1");
    assert.equal(finished[0].name, "write_file");
  });

  it("carries the called name on pre-execution denial paths", async () => {
    // Invalid argumentsRaw is rejected before bridge resolution — the name
    // must still come through (from the raw call) for UI consumers.
    const session = makeSession();
    const events: StreamEvent[] = [];
    let n = 0;
    const args = { path: join(wsDir, "note.txt") };
    const result = await runTools({
      session,
      assistantMessageId: "m-2",
      toolCalls: [
        makeCall("call-edit-1", "edit_file", args, "{not json"),
      ],
      gate: { fullPermissionsEnabled: true } as PermissionGateState,
      createId: () => `id-${++n}`,
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.cancelled, false);
    assert.ok(result.toolFailureCount > 0, "invalid args should fail");

    const finished = finishedEvents(events);
    assert.equal(finished.length, 1);
    assert.ok(finished[0], "tool_finished present");
    assert.equal(finished[0].name, "edit_file");
  });
});
