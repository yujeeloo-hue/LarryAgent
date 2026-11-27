import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createWorkspaceDefinition,
  createWorkspaceHandler,
} from "./createWorkspace.js";
import {
  configureWorkspaceManager,
  type WorkspaceManagerCreateResult,
  type WorkspaceManagerPort,
} from "../workspaceManagerPort.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  JsonObject,
  ToolExecuteContext,
  ToolExecuteResult,
} from "../types.js";

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
  return createWorkspaceHandler(args, context) as Promise<ToolExecuteResult>;
}

function text(res: ToolExecuteResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

function fakePort(result: Partial<WorkspaceManagerCreateResult> = {}) {
  const calls: Array<{ name: string; path: string }> = [];
  const manager: WorkspaceManagerPort = {
    create: async (input) => {
      calls.push(input);
      return {
        id: "ws-1",
        name: input.name,
        path: input.path,
        existing: false,
        ...result,
      };
    },
    rename: async () => {
      throw new Error("rename is not part of this test fake");
    },
  };
  return { manager, calls };
}

afterEach(() => {
  configureWorkspaceManager(null);
});

describe("create_workspace definition", () => {
  it("is a level-1 builtin requiring name and absolute path", () => {
    assert.equal(createWorkspaceDefinition.name, "create_workspace");
    assert.equal(createWorkspaceDefinition.defaultPermissionLevel, 1);
    const schema = createWorkspaceDefinition.parameters as {
      required?: string[];
      additionalProperties?: boolean;
    };
    assert.deepEqual(schema.required, ["name", "path"]);
    assert.equal(schema.additionalProperties, false);
    assert.match(createWorkspaceDefinition.description, /headless Linux agentd/i);
  });

  it("is wired into catalog, registry, summaries, icon catalog and both hosts", () => {
    const read = (rel: string) =>
      readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(read("../types.ts"), /\| "create_workspace"/);
    assert.match(read("../catalog.ts"), /create_workspace: "filesystem"/);
    assert.match(
      read("../index.ts"),
      /registerBuiltin\(createWorkspaceDefinition, createWorkspaceHandler\)/,
    );
    assert.match(read("../displayMeta.ts"), /create_workspace: \{/);
    assert.match(read("../executionSummaries.ts"), /create_workspace: \(/);
    assert.match(read("../uiDescriptions.ts"), /create_workspace:/);
    assert.match(
      read("../../shared/icons/toolIconCatalog.ts"),
      /"create_workspace":/,
    );
    assert.match(
      read("../../main/index.ts"),
      /configureWorkspaceManager\(createWorkspaceManagerPort\(store\)\)/,
    );
    assert.match(
      read("../../agentd/runMain.ts"),
      /configureWorkspaceManager\(createWorkspaceManagerPort\(store\)\)/,
    );
  });
});

describe("create_workspace handler", () => {
  it("reports a usable error when no host installed the port", async () => {
    const res = await run({ name: "demo", path: "/tmp/demo" }, ctx());
    assert.equal(res.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(res), /unavailable in this host/i);
  });

  it("rejects missing or relative arguments before touching the port", async () => {
    const { manager, calls } = fakePort();
    for (const args of [
      { path: "/tmp/demo" },
      { name: "demo" },
      { name: "  ", path: "/tmp/demo" },
      { name: "demo", path: "  " },
      { name: "demo", path: "./relative" },
    ]) {
      const res = await run(args, ctx({ workspaceManager: manager }));
      assert.equal(res.returnCode, ToolReturnCode.InvalidArguments);
    }
    assert.equal(calls.length, 0);
  });

  it("normalizes the absolute path and returns the new workspace", async () => {
    const { manager, calls } = fakePort();
    const target = resolve("/tmp/jellybot-workspace");
    const res = await run(
      { name: "Demo", path: target },
      ctx({ workspaceManager: manager }),
    );
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.deepEqual(calls, [{ name: "Demo", path: target }]);
    assert.match(text(res), /workspace created: Demo \(id ws-1\)/);
    assert.match(text(res), /active workspace: ws-1/);
    assert.match(text(res), /current session workspace unchanged/);
  });

  it("reports a reused workspace without duplicating it", async () => {
    const { manager } = fakePort({ existing: true, id: "old-id" });
    const res = await run(
      { name: "Demo", path: "/tmp/demo" },
      ctx({ workspaceManager: manager }),
    );
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.match(text(res), /workspace reused: Demo \(id old-id\)/);
  });

  it("honours the path guard and surfaces port failures", async () => {
    const { manager } = fakePort();
    const denied = await run(
      { name: "Demo", path: "/tmp/demo" },
      ctx({
        workspaceManager: manager,
        assertPath: () => {
          throw new Error("path is not materialized");
        },
      }),
    );
    assert.equal(denied.returnCode, ToolReturnCode.PermissionDenied);
    assert.match(text(denied), /not materialized/);

    const failing: WorkspaceManagerPort = {
      create: async () => {
        throw new Error("mkdir denied");
      },
      rename: async () => {
        throw new Error("rename denied");
      },
    };
    const failed = await run(
      { name: "Demo", path: "/tmp/demo" },
      ctx({ workspaceManager: failing }),
    );
    assert.equal(failed.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(failed), /mkdir denied/);
  });

  it("falls back to the globally configured port", async () => {
    const { manager, calls } = fakePort();
    configureWorkspaceManager(manager);
    const res = await run(
      { name: "Headless", path: "/srv/jellybot-agent/workspaces/demo" },
      ctx(),
    );
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "Headless");
  });
});
