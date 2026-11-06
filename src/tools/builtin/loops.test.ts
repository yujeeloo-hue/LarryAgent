/**
 * loops tool — CRUD against a fake LoopsToolPort (service semantics:
 * whole-object create/update, UUID ids, cadence validation) + regex
 * wiring locks mirroring fsmGraphTool.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loopsDefinition, loopsHandler } from "./loops.js";
import type { JsonObject, ToolExecuteContext, ToolExecuteResult } from "../types.js";
import type {
  LoopRunViewLike,
  LoopViewLike,
  LoopsToolPort,
} from "../loopsTool.js";
import {
  describeCadence,
  isValidCadence,
  nextRunAt,
  type Cadence,
} from "../../loops/schedule.js";
import type { ReasoningEffort } from "../../llm/reasoningEffort.js";
// Type-only: service.ts imports electron; erased at runtime.
import type { LoopsService } from "../../main/loops/service.js";

// Compile-time lock: the live LoopsService satisfies the structural port.
const _loopsServiceIsPort: LoopsToolPort | null =
  null as unknown as LoopsService | null;

// ------------------------------------------------------------ fake port

function fakeLoop(over: Partial<LoopViewLike> = {}): LoopViewLike {
  return {
    id: "loop-1",
    name: "Loop",
    prompt: "do the thing",
    workspaceId: "ws-1",
    runMode: "agent",
    providerId: "",
    reasoningEffort: "low",
    fullPermissions: false,
    cadenceJson: JSON.stringify({ kind: "day", time: "09:00" }),
    enabled: true,
    nextRunAt: 1_800_000_000_000,
    lastRunAt: null,
    runCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    cadenceSummary: "Daily at 09:00",
    ...over,
  };
}

function fakeRun(over: Partial<LoopRunViewLike> = {}): LoopRunViewLike {
  return {
    id: "run-1",
    loopId: "loop-1",
    sessionId: "sess-1",
    status: "succeeded",
    startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_060_000,
    error: null,
    ...over,
  };
}

function createFakePort(seed: LoopViewLike[] = []): {
  port: LoopsToolPort;
  loops: LoopViewLike[];
  runsByLoop: Map<string, LoopRunViewLike[]>;
} {
  const loops = seed.map((loop) => ({ ...loop }));
  const runsByLoop = new Map<string, LoopRunViewLike[]>();
  const port: LoopsToolPort = {
    list: () => loops.map((loop) => ({ ...loop })),
    create: (raw) => {
      const req = raw as Record<string, unknown>;
      const cadence = req.cadence;
      if (typeof req.name !== "string" || !req.name.trim()) {
        throw new Error("loops: name must be a non-empty string");
      }
      if (typeof req.prompt !== "string" || !req.prompt.trim()) {
        throw new Error("loops: prompt must be a non-empty string");
      }
      if (typeof req.workspaceId !== "string" || !req.workspaceId.trim()) {
        throw new Error("loops: workspaceId must be a non-empty string");
      }
      if (!isValidCadence(cadence)) {
        throw new Error("loops: cadence is invalid");
      }
      const enabled = req.enabled !== false;
      const loop = fakeLoop({
        id: `loop-${loops.length + 1}`,
        name: req.name.trim(),
        prompt: req.prompt.trim(),
        workspaceId: req.workspaceId.trim(),
        runMode:
          req.runMode === "plan" || req.runMode === "ask" ? req.runMode : "agent",
        providerId: typeof req.providerId === "string" ? req.providerId : "",
        reasoningEffort: (req.reasoningEffort ?? "low") as ReasoningEffort,
        fullPermissions: req.fullPermissions === true,
        cadenceJson: JSON.stringify(cadence),
        cadenceSummary: describeCadence(cadence),
        enabled,
        nextRunAt: enabled ? nextRunAt(cadence, new Date()).getTime() : null,
      });
      loops.push(loop);
      return { ...loop };
    },
    update: (id, raw) => {
      const index = loops.findIndex((loop) => loop.id === id);
      if (index < 0) return null;
      const req = raw as Record<string, unknown>;
      const cadence = req.cadence as Cadence;
      const enabled = req.enabled !== false;
      const updated = fakeLoop({
        ...loops[index]!,
        name: String(req.name),
        prompt: String(req.prompt),
        workspaceId: String(req.workspaceId),
        runMode: (req.runMode as LoopViewLike["runMode"]) ?? "agent",
        providerId: typeof req.providerId === "string" ? req.providerId : "",
        reasoningEffort: (req.reasoningEffort as ReasoningEffort) ?? "low",
        fullPermissions: req.fullPermissions === true,
        cadenceJson: JSON.stringify(cadence),
        cadenceSummary: describeCadence(cadence),
        enabled,
        nextRunAt: enabled ? nextRunAt(cadence, new Date()).getTime() : null,
        updatedAt: 1_900_000_000_000,
      });
      loops[index] = updated;
      return { ...updated };
    },
    remove: (id) => {
      const index = loops.findIndex((loop) => loop.id === id);
      if (index < 0) return false;
      loops.splice(index, 1);
      return true;
    },
    listRuns: (id, limit = 20) =>
      (runsByLoop.get(id) ?? []).slice(0, limit).map((run) => ({ ...run })),
  };
  return { port, loops, runsByLoop };
}

// ------------------------------------------------------------ helpers

function ctx(port: LoopsToolPort | null, workspaceId?: string): ToolExecuteContext {
  return {
    workspacePath: "/tmp/workspace",
    ...(workspaceId ? { workspaceId } : {}),
    ...(port ? { loops: port } : {}),
    fullPermissionsEnabled: false,
  };
}

function text(result: ToolExecuteResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

async function run(args: JsonObject, context: ToolExecuteContext): Promise<ToolExecuteResult> {
  return loopsHandler(args, context);
}

// ------------------------------------------------------------ handler

describe("loops handler", () => {
  it("reports unavailability when the port is absent", async () => {
    const res = await run({ action: "list" }, ctx(null));
    assert.equal(res.returnCode, 1);
    assert.match(text(res), /not available/);
  });

  it("list on an empty store guides to create", async () => {
    const { port } = createFakePort();
    const res = await run({ action: "list" }, ctx(port));
    assert.equal(res.returnCode, 0);
    assert.match(text(res), /No loops exist yet/);
  });

  it("list renders one scannable line per loop", async () => {
    const { port } = createFakePort([
      fakeLoop({ id: "a1", name: "Nightly build", runCount: 3 }),
      fakeLoop({ id: "b2", name: "Standup", enabled: false, nextRunAt: null }),
    ]);
    const res = await run({ action: "list" }, ctx(port));
    const out = text(res);
    assert.match(out, /Loops \(2\)/);
    assert.match(out, /a1 · "Nightly build"/);
    assert.match(out, /Daily at 09:00/);
    assert.match(out, /b2 · "Standup"/);
    assert.match(out, /paused/);
    assert.match(out, /3 run\(s\)/);
  });

  it("create applies session defaults (workspace, agent, low, enabled)", async () => {
    const { port, loops } = createFakePort();
    const res = await run(
      {
        action: "create",
        name: "Morning digest",
        prompt: "Summarize overnight changes.",
        cadence: { kind: "day", time: "08:30" },
      },
      ctx(port, "ws-42"),
    );
    assert.equal(res.returnCode, 0);
    const created = loops[0]!;
    assert.equal(created.workspaceId, "ws-42");
    assert.equal(created.runMode, "agent");
    assert.equal(created.providerId, "");
    assert.equal(created.reasoningEffort, "low");
    assert.equal(created.fullPermissions, false);
    assert.equal(created.enabled, true);
    assert.notEqual(created.nextRunAt, null);
    assert.match(text(res), /Created loop "Morning digest"/);
    assert.match(text(res), /Daily at 08:30/);
  });

  it("create rejects a missing/invalid cadence with schema guidance", async () => {
    const { port } = createFakePort();
    const missing = await run(
      { action: "create", name: "x", prompt: "y" },
      ctx(port, "ws-1"),
    );
    assert.equal(missing.returnCode, 5);
    assert.match(text(missing), /cadence is required/);

    const invalid = await run(
      { action: "create", name: "x", prompt: "y", cadence: { kind: "day", time: "9:00" } },
      ctx(port, "ws-1"),
    );
    assert.equal(invalid.returnCode, 5);
    assert.match(text(invalid), /Invalid cadence/);
  });

  it("create requires a workspace when the session has none", async () => {
    const { port } = createFakePort();
    const res = await run(
      { action: "create", name: "x", prompt: "y", cadence: { kind: "hour", minute: 30 } },
      ctx(port), // no workspaceId
    );
    assert.equal(res.returnCode, 5);
    assert.match(text(res), /workspaceId/);
  });

  it("get resolves by id and by unique name, with prompt + runs", async () => {
    const { port, runsByLoop } = createFakePort([
      fakeLoop({ id: "loop-9", name: "Weekly report", prompt: "Line one\nLine two" }),
    ]);
    runsByLoop.set("loop-9", [
      fakeRun({ loopId: "loop-9", status: "failed", error: "boom" }),
    ]);
    const byId = await run({ action: "get", id: "loop-9" }, ctx(port));
    assert.equal(byId.returnCode, 0);
    const out = text(byId);
    assert.match(out, /"Weekly report" \(loop-9\)/);
    assert.match(out, /Line one/);
    assert.match(out, /failed/);
    assert.match(out, /boom/);

    const byName = await run({ action: "get", id: "Weekly report" }, ctx(port));
    assert.equal(byName.returnCode, 0);
    assert.match(text(byName), /loop-9/);
  });

  it("get on an unknown ref is NotFound with list guidance", async () => {
    const { port } = createFakePort();
    const res = await run({ action: "get", id: "nope" }, ctx(port));
    assert.equal(res.returnCode, 3);
    assert.match(text(res), /action=list/);
  });

  it("ambiguous name refs list ids instead of guessing", async () => {
    const { port } = createFakePort([
      fakeLoop({ id: "one", name: "dup" }),
      fakeLoop({ id: "two", name: "dup" }),
    ]);
    const res = await run({ action: "get", id: "dup" }, ctx(port));
    assert.equal(res.returnCode, 3);
    assert.match(text(res), /Multiple loops/);
    assert.match(text(res), /one, two/);
  });

  it("update patches only the given fields (merge preserves the rest)", async () => {
    const { port, loops } = createFakePort([
      fakeLoop({
        id: "loop-7",
        name: "Old name",
        prompt: "Keep me",
        providerId: "prov-a",
        reasoningEffort: "high",
      }),
    ]);
    const res = await run(
      {
        action: "update",
        id: "loop-7",
        cadence: { kind: "week", weekdays: [1], time: "10:00" },
        enabled: false,
      },
      ctx(port),
    );
    assert.equal(res.returnCode, 0);
    assert.match(text(res), /changed: cadence, enabled/);
    const updated = loops[0]!;
    assert.equal(updated.name, "Old name");
    assert.equal(updated.prompt, "Keep me");
    assert.equal(updated.providerId, "prov-a");
    assert.equal(updated.reasoningEffort, "high");
    assert.equal(updated.enabled, false);
    assert.equal(updated.nextRunAt, null);
    assert.match(updated.cadenceSummary, /Weekly on Mon/);
  });

  it("update with nothing to change fails with the settable list", async () => {
    const { port } = createFakePort([fakeLoop()]);
    const res = await run({ action: "update", id: "loop-1" }, ctx(port));
    assert.equal(res.returnCode, 5);
    assert.match(text(res), /at least one settable field/);
  });

  it("update on an unknown ref is NotFound", async () => {
    const { port } = createFakePort();
    const res = await run(
      { action: "update", id: "ghost", name: "n" },
      ctx(port),
    );
    assert.equal(res.returnCode, 3);
  });

  it("delete removes the loop and reports its run count", async () => {
    const { port, loops } = createFakePort([
      fakeLoop({ id: "loop-3", name: "Cull me", runCount: 12 }),
    ]);
    const res = await run({ action: "delete", id: "Cull me" }, ctx(port));
    assert.equal(res.returnCode, 0);
    assert.match(text(res), /Deleted loop "Cull me"/);
    assert.match(text(res), /12 run\(s\)/);
    assert.equal(loops.length, 0);

    const after = await run({ action: "delete", id: "Cull me" }, ctx(port));
    assert.equal(after.returnCode, 3);
  });

  it("runs lists history and explains a never-run loop", async () => {
    const { port, runsByLoop } = createFakePort([fakeLoop({ id: "loop-5", name: "Runner" })]);
    runsByLoop.set("loop-5", [
      fakeRun({ loopId: "loop-5", startedAt: 1_800_000_000_000, status: "succeeded" }),
      fakeRun({
        loopId: "loop-5",
        id: "run-0",
        startedAt: 1_799_999_000_000,
        status: "timeout",
        sessionId: null,
        endedAt: null,
      }),
    ]);
    const res = await run({ action: "runs", id: "Runner" }, ctx(port));
    assert.equal(res.returnCode, 0);
    const out = text(res);
    assert.match(out, /latest 2/);
    assert.match(out, /succeeded · 60s/);
    assert.match(out, /timeout/);

    const fresh = createFakePort([fakeLoop({ name: "Fresh" })]);
    const never = await run({ action: "runs", id: "Fresh" }, ctx(fresh.port));
    assert.match(text(never), /has never run/);
  });

  it("unknown action is an argument error", async () => {
    const { port } = createFakePort();
    const res = await run({ action: "pause" }, ctx(port));
    assert.equal(res.returnCode, 5);
    assert.match(text(res), /list\|get\|create\|update\|delete\|runs/);
  });

  it("definition: name loops, level 1, six actions", () => {
    assert.equal(loopsDefinition.name, "loops");
    assert.equal(loopsDefinition.defaultPermissionLevel, 1);
    const props = loopsDefinition.parameters.properties as Record<
      string,
      { enum?: string[] }
    > | undefined;
    const action = props?.action;
    assert.deepEqual(action?.enum, [
      "list",
      "get",
      "create",
      "update",
      "delete",
      "runs",
    ]);
  });
});

// ------------------------------------------------------------ wiring locks

const ROOT = new URL("../../../", import.meta.url);

function src(rel: string): string {
  return readFileSync(new URL(rel, ROOT), "utf8");
}

describe("loops tool wiring", () => {
  it("ToolExecuteContext declares the loops port", async () => {
    const body = src("src/tools/types.ts");
    assert.match(
      body,
      /loops\?: import\("\.\/loopsTool\.js"\)\.LoopsToolPort/,
    );
  });

  it("runTools declares, destructures, and forwards loops", async () => {
    const body = src("src/agent/runTools.ts");
    assert.match(
      body,
      /loops\?: import\("\.\.\/tools\/loopsTool\.js"\)\.LoopsToolPort/,
      "runTools input type must declare loops",
    );
    assert.match(body, /\n    loops,/, "runTools must destructure loops");
    assert.match(
      body,
      /\.\.\.\(loops \? \{ loops \} : \{\}\)/,
      "runTools must forward loops into the tool context",
    );
  });

  it("RunAgentTurnInput and TurnHost input declare loops", async () => {
    const agent = src("src/agent/types.ts");
    assert.match(
      agent,
      /loops\?: import\("\.\.\/tools\/loopsTool\.js"\)\.LoopsToolPort/,
    );
    const host = src("src/agent/turnHost/types.ts");
    assert.match(
      host,
      /loops\?: import\("\.\.\/\.\.\/tools\/loopsTool\.js"\)\.LoopsToolPort/,
    );
  });

  it("createTurnHost forwards loops to subagents and runTools (2 sites)", async () => {
    const body = src("src/agent/turnHost/createTurnHost.ts");
    const hits = body.match(/\.\.\.\(input\.loops \? \{ loops: input\.loops \} : \{\}\)/g);
    assert.equal(hits?.length, 2);
  });

  it("subagent manager forwards loops to child turns", async () => {
    const body = src("src/agent/subagents/manager.ts");
    assert.match(body, /loops\?: RunAgentTurnInput\["loops"\]/);
    assert.match(
      body,
      /\.\.\.\(this\.input\.loops \? \{ loops: this\.input\.loops \} : \{\}\)/,
    );
  });

  // Loops was retired in favor of CoCo: the builtin stays unregistered and main
  // clears the port. Lock the retired state so it cannot silently resurrect.
  it("main clears the service port instead of booting the daemon", async () => {
    const index = src("src/main/index.ts");
    assert.doesNotMatch(index, /setLoopsToolPort\(loopsService\)/);
    assert.match(index, /setLoopsToolPort\(null\)/);
    const runtime = src("src/main/sessionRuntime.ts");
    assert.match(runtime, /import \{ getLoopsToolPort \} from "\.\/loops\/toolAccess\.js"/);
    assert.match(runtime, /\.\.\.\(loopsToolPort \? \{ loops: loopsToolPort \} : \{\}\)/);
  });

  it("builtin is not registered (superseded by CoCo) but stays catalogued", async () => {
    const index = src("src/tools/index.ts");
    assert.doesNotMatch(index, /registerBuiltin\(loopsDefinition, loopsHandler\)/);
    const catalog = src("src/tools/catalog.ts");
    assert.match(catalog, /loops: "orchestration"/);
  });
});
