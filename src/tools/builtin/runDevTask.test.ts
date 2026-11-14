/**
 * run_dev_task — fake-port behaviour: action routing, workspace scoping,
 * wait / wait_ms / abort, status/stop, output formatting, catalog wiring.
 *
 * The live runner lives in Electron main (devTaskRunner.ts); this suite stays
 * in plain node by injecting the structural port through the context.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  runDevTaskDefinition,
  runDevTaskHandler,
} from "./runDevTask.js";
import {
  configureDevTaskRunner,
  type DevTaskRunSnapshot,
  type DevTaskRunnerPort,
} from "../devTaskRunnerPort.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  JsonObject,
  ToolExecuteContext,
  ToolExecuteResult,
} from "../types.js";

function snap(over: Partial<DevTaskRunSnapshot> = {}): DevTaskRunSnapshot {
  return {
    runId: "run-1",
    task: "build",
    workspacePath: "/ws",
    command: "npm run build",
    status: "done",
    exitCode: 0,
    startedAt: Date.now() - 1200,
    durationMs: 1200,
    buffer: "build ok\n",
    bufferTruncated: false,
    failureHint: null,
    ...over,
  };
}

const TASKS = [
  { id: "build", command: "npm run build" },
  { id: "run", command: "npm run dev" },
  { id: "deploy", command: "npm run publish" },
];

function fakePort(over: Partial<DevTaskRunnerPort> = {}) {
  const runs: Array<{ workspacePath: string; task: string }> = [];
  const stopped: string[] = [];
  const port: DevTaskRunnerPort = {
    run: async (input) => {
      runs.push({ workspacePath: input.workspacePath, task: input.task });
      return { ok: true, runId: "run-1", command: `npm run ${input.task}` };
    },
    listTasks: async () => ({ ok: true, tasks: TASKS }),
    awaitRun: async () => snap(),
    snapshot: () => snap({ status: "running", exitCode: null, durationMs: null }),
    state: () => ({ active: [], last: {} }),
    stop: (id) => {
      stopped.push(id);
      return true;
    },
    ...over,
  };
  return { port, runs, stopped };
}

function ctx(over: Partial<ToolExecuteContext> = {}): ToolExecuteContext {
  return {
    workspacePath: "/ws",
    fullPermissionsEnabled: false,
    ...over,
  } as ToolExecuteContext;
}

function run(
  args: JsonObject,
  context: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  return runDevTaskHandler(args, context) as Promise<ToolExecuteResult>;
}

function text(res: ToolExecuteResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

describe("run_dev_task definition", () => {
  it("is a level-1 builtin with the full lifecycle in its schema", () => {
    assert.equal(runDevTaskDefinition.name, "run_dev_task");
    assert.equal(runDevTaskDefinition.defaultPermissionLevel, 1);
    const props = runDevTaskDefinition.parameters.properties as Record<
      string,
      { enum?: string[] }
    >;
    assert.deepEqual(props.action?.enum, ["run", "list", "status", "stop"]);
    for (const key of ["task", "run_id", "workspace_id", "workspace_path", "wait", "wait_ms"]) {
      assert.ok(props[key], `missing ${key}`);
    }
    assert.match(runDevTaskDefinition.description, /build, run or deploy/i);
  });

  it("is wired into catalog, registry, summaries and icon catalog", () => {
    const read = (rel: string) =>
      readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(read("../catalog.ts"), /run_dev_task: "development"/);
    assert.match(read("../index.ts"), /registerBuiltin\(runDevTaskDefinition, runDevTaskHandler\)/);
    assert.match(read("../executionSummaries.ts"), /run_dev_task: \(/);
    assert.match(read("../uiDescriptions.ts"), /run_dev_task:/);
    assert.match(read("../../shared/icons/toolIconCatalog.ts"), /"run_dev_task":/);
    assert.match(read("../../main/index.ts"), /configureDevTaskRunner\(createDevTaskRunnerPort\(\)\)/);
  });
});

describe("run_dev_task port + argument validation", () => {
  it("reports unavailability when no runner is configured", async () => {
    const res = await run({ task: "build" }, ctx());
    assert.equal(res.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(res), /no dev task runner/);
  });

  it("uses the process-wide runner when the context has no override", async () => {
    const { port, runs } = fakePort();
    configureDevTaskRunner(port);
    try {
      const res = await run({ task: "build" }, ctx());
      assert.equal(res.returnCode, ToolReturnCode.Success);
      assert.equal(runs.length, 1);
    } finally {
      configureDevTaskRunner(null);
    }
  });

  it("rejects unknown actions, missing / malformed task ids", async () => {
    const { port, runs } = fakePort();
    const bad: JsonObject[] = [
      { action: "explode" },
      { task: "" },
      { task: "../evil" },
      { task: "x".repeat(40) },
    ];
    for (const args of bad) {
      const res = await run(args, ctx({ devTaskRunner: port }));
      assert.equal(res.returnCode, ToolReturnCode.InvalidArguments, JSON.stringify(args));
    }
    assert.equal(runs.length, 0);
  });

  it("lists effective tasks and flags an undefined task with available ids", async () => {
    const { port } = fakePort();
    const listed = await run({ action: "list" }, ctx({ devTaskRunner: port }));
    assert.equal(listed.returnCode, ToolReturnCode.Success);
    assert.match(text(listed), /3 task\(s\)/);
    assert.match(text(listed), /- deploy: npm run publish/);

    const missing = await run({ task: "ship" }, ctx({ devTaskRunner: port }));
    assert.equal(missing.returnCode, ToolReturnCode.NotFound);
    assert.match(text(missing), /Available: build, run, deploy/);
    assert.match(text(missing), /dev_tasks/);
  });

  it("surfaces config / start failures without waiting", async () => {
    const { port } = fakePort({
      listTasks: async () => ({ ok: false, message: "bad tasks.json" }),
    });
    const cfg = await run({ task: "build" }, ctx({ devTaskRunner: port }));
    assert.equal(cfg.returnCode, ToolReturnCode.NotFound);
    assert.match(text(cfg), /bad tasks.json/);

    const { port: startPort } = fakePort({
      run: async () => ({ ok: false, message: "runner busy" }),
    });
    const start = await run({ task: "build" }, ctx({ devTaskRunner: startPort }));
    assert.equal(start.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(start), /runner busy/);
  });
});

describe("run_dev_task run lifecycle", () => {
  it("waits by default and returns exit code + output + hint on failure", async () => {
    const { port } = fakePort({
      awaitRun: async () =>
        snap({ status: "failed", exitCode: 2, buffer: "error TS2552\n", failureHint: "UBT: missing module" }),
    });
    const res = await run({ task: "build" }, ctx({ devTaskRunner: port }));
    assert.equal(res.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(res), /status failed · exit 2/);
    assert.match(text(res), /hint: UBT: missing module/);
    assert.match(text(res), /error TS2552/);
  });

  it("maps timeout / cancelled / spawn-error terminal states to return codes", async () => {
    for (const [status, code] of [
      ["timeout", ToolReturnCode.Timeout],
      ["cancelled", ToolReturnCode.Cancelled],
      ["spawn-error", ToolReturnCode.GenericFailure],
    ] as const) {
      const { port } = fakePort({ awaitRun: async () => snap({ status, exitCode: null }) });
      const res = await run({ task: "deploy" }, ctx({ devTaskRunner: port }));
      assert.equal(res.returnCode, code, status);
      assert.match(text(res), new RegExp(`status ${status}`));
    }
  });

  it("wait=false returns the run_id without awaiting", async () => {
    let awaited = 0;
    const { port } = fakePort({
      awaitRun: async () => {
        awaited += 1;
        return snap();
      },
    });
    const res = await run({ task: "run", wait: false }, ctx({ devTaskRunner: port }));
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.equal(awaited, 0);
    assert.match(text(res), /run_id run-1/);
    assert.match(text(res), /action=status/);
  });

  it("attaches to an already-running task instead of starting a duplicate", async () => {
    const { port, runs } = fakePort({
      run: async () => ({ ok: false, message: "Task \"build\" is already running", runId: "run-1" }),
      awaitRun: async () => snap({ runId: "run-1" }),
    });
    const res = await run({ task: "build" }, ctx({ devTaskRunner: port }));
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.equal(runs.length, 0);
    assert.match(text(res), /Attached to the already-running/);
  });

  it("wait_ms stops waiting but not the task", async () => {
    const { port } = fakePort({
      awaitRun: () => new Promise(() => {}),
      snapshot: () => snap({ status: "running", exitCode: null, durationMs: null, buffer: "compiling...\n" }),
    });
    const res = await run(
      { task: "build", wait_ms: 5 },
      ctx({ devTaskRunner: port }),
    );
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.match(text(res), /still running after 5ms/);
    assert.match(text(res), /the wait stopped, not the task/);
    assert.match(text(res), /compiling/);
  });

  it("abort while waiting reports cancellation and keeps the run alive", async () => {
    const controller = new AbortController();
    const { port } = fakePort({ awaitRun: () => new Promise(() => {}) });
    const pending = run({ task: "build" }, ctx({ devTaskRunner: port, signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    const res = await pending;
    assert.equal(res.returnCode, ToolReturnCode.Cancelled);
    assert.match(text(res), /keeps running/);
    assert.match(text(res), /action=stop/);
  });

  it("truncates long output to the tail", async () => {
    const buffer = "a".repeat(20_000) + "TAIL-MARK\n";
    const { port } = fakePort({ awaitRun: async () => snap({ buffer }) });
    const res = await run({ task: "build" }, ctx({ devTaskRunner: port }));
    const body = text(res);
    assert.match(body, /TAIL-MARK/);
    assert.match(body, /earlier output omitted/);
    assert.ok(body.length < 20_000);
  });

  it("handles a pruned run snapshot", async () => {
    const { port } = fakePort({ awaitRun: async () => null });
    const res = await run({ task: "build" }, ctx({ devTaskRunner: port }));
    assert.equal(res.returnCode, ToolReturnCode.NotFound);
    assert.match(text(res), /no longer available/);
  });
});

describe("run_dev_task status / stop", () => {
  it("status by run_id reports the snapshot, unknown ids are NotFound", async () => {
    const { port } = fakePort({
      snapshot: () => snap({ status: "failed", exitCode: 1, failureHint: "link failed" }),
    });
    const res = await run({ action: "status", run_id: "run-1" }, ctx({ devTaskRunner: port }));
    assert.equal(res.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(res), /status failed · exit 1/);
    assert.match(text(res), /link failed/);

    const { port: empty } = fakePort({ snapshot: () => null });
    const gone = await run({ action: "status", run_id: "nope" }, ctx({ devTaskRunner: empty }));
    assert.equal(gone.returnCode, ToolReturnCode.NotFound);
  });

  it("status without run_id lists active + last, optionally filtered by task", async () => {
    const active = snap({ runId: "run-2", task: "run", status: "running", exitCode: null, durationMs: null });
    const last = snap({ runId: "run-1", task: "build" });
    const { port } = fakePort({ state: () => ({ active: [active], last: { build: last } }) });
    const all = await run({ action: "status" }, ctx({ devTaskRunner: port }));
    assert.match(text(all), /active:\n- run · run run-2/);
    assert.match(text(all), /last:\n- build · run run-1/);

    const filtered = await run({ action: "status", task: "deploy" }, ctx({ devTaskRunner: port }));
    assert.match(text(filtered), /active: \(none for task "deploy"\)/);
    assert.match(text(filtered), /last: \(none for task "deploy"\)/);
  });

  it("stop accepts run_id or an active task, and rejects nothing-to-stop", async () => {
    const { port, stopped } = fakePort({
      state: () => ({ active: [snap({ runId: "run-9", task: "run", status: "running" })], last: {} }),
    });
    const byId = await run({ action: "stop", run_id: "run-9" }, ctx({ devTaskRunner: port }));
    assert.equal(byId.returnCode, ToolReturnCode.Success);
    const byTask = await run({ action: "stop", task: "run" }, ctx({ devTaskRunner: port }));
    assert.equal(byTask.returnCode, ToolReturnCode.Success);
    assert.deepEqual(stopped, ["run-9", "run-9"]);

    const missing = await run({ action: "stop" }, ctx({ devTaskRunner: port }));
    assert.equal(missing.returnCode, ToolReturnCode.InvalidArguments);
  });
});

describe("run_dev_task workspace scoping", () => {
  it("defaults to the session workspace", async () => {
    const { port, runs } = fakePort();
    await run({ task: "build" }, ctx({ devTaskRunner: port }));
    assert.equal(runs.length, 1);
    assert.match(runs[0]!.workspacePath, /ws$/);
  });

  it("resolves workspace_id by name via CoCo's in-scope project resolver", async () => {
    const { port, runs } = fakePort();
    const seen: string[] = [];
    const context = ctx({
      devTaskRunner: port,
      cocoProjectPath: (id) => {
        seen.push(id);
        if (id !== "site") throw new Error("excluded project");
        return "/work/site";
      },
      listWorkspaces: () => [{ id: "site", name: "Site" }],
    });
    const res = await run({ task: "deploy", workspace_id: "Site" }, context);
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.deepEqual(seen, ["site"]);
    assert.match(runs[0]!.workspacePath, /work[\\/]site$/);
  });

  it("rejects workspace_id on ordinary sessions and unknown names", async () => {
    const { port, runs } = fakePort();
    const ordinary = await run({ task: "build", workspace_id: "site" }, ctx({ devTaskRunner: port }));
    assert.equal(ordinary.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(text(ordinary), /only available to CoCo/);

    const unknown = await run(
      { task: "build", workspace_id: "ghost" },
      ctx({
        devTaskRunner: port,
        cocoProjectPath: () => "/work/site",
        listWorkspaces: () => [{ id: "site", name: "Site" }],
      }),
    );
    assert.equal(unknown.returnCode, ToolReturnCode.NotFound);
    assert.match(text(unknown), /Available: "Site" \(site\)/);
    assert.equal(runs.length, 0);
  });

  it("workspace_path honors the path boundary + assertPath, rejects both args", async () => {
    const { port, runs } = fakePort();
    const both = await run(
      { task: "build", workspace_id: "site", workspace_path: "/other" },
      ctx({ devTaskRunner: port, cocoProjectPath: () => "/work/site" }),
    );
    assert.equal(both.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(text(both), /either workspace_id or workspace_path/);

    const denied = await run({ task: "build", workspace_path: "/other" }, ctx({ devTaskRunner: port }));
    assert.equal(denied.returnCode, ToolReturnCode.PermissionDenied);
    assert.match(text(denied), /outside the workspace/);

    const asserted: string[] = [];
    const allowed = await run(
      { task: "build", workspace_path: "/other" },
      ctx({
        devTaskRunner: port,
        fullPermissionsEnabled: true,
        assertPath: (p) => { asserted.push(p); },
      }),
    );
    assert.equal(allowed.returnCode, ToolReturnCode.Success);
    assert.equal(asserted.length, 1);
    assert.match(runs[0]!.workspacePath, /other$/);

    const blocked = await run(
      { task: "build", workspace_path: "/other" },
      ctx({
        devTaskRunner: port,
        fullPermissionsEnabled: true,
        assertPath: () => { throw new Error("project excluded"); },
      }),
    );
    assert.equal(blocked.returnCode, ToolReturnCode.PermissionDenied);
    assert.match(text(blocked), /project excluded/);
  });
});
