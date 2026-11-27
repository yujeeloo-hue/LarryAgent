import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  renameWorkspaceDefinition,
  renameWorkspaceHandler,
} from "./renameWorkspace.js";
import {
  configureWorkspaceManager,
  type WorkspaceManagerPort,
  type WorkspaceManagerRenameResult,
} from "../workspaceManagerPort.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  JsonObject,
  ToolExecuteContext,
  ToolExecuteResult,
} from "../types.js";

function ctx(over: Record<string, unknown> = {}): ToolExecuteContext {
  return {
    workspacePath: "/ws",
    workspaceId: "current-id",
    fullPermissionsEnabled: false,
    ...over,
  } as ToolExecuteContext;
}

function run(
  args: JsonObject,
  context: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  return renameWorkspaceHandler(args, context) as Promise<ToolExecuteResult>;
}

function text(res: ToolExecuteResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

function fakePort(result: Partial<WorkspaceManagerRenameResult> = {}) {
  const calls: Array<{ id?: string; path?: string; name: string }> = [];
  const manager: WorkspaceManagerPort = {
    create: async () => {
      throw new Error("create is not part of this test fake");
    },
    rename: async (input) => {
      calls.push(input);
      return {
        id: "ws-1",
        name: input.name,
        path: "/srv/jellybot-agent/workspaces/demo",
        previousName: "Demo",
        ...result,
      };
    },
  };
  return { manager, calls };
}

afterEach(() => {
  configureWorkspaceManager(null);
});

describe("rename_workspace definition", () => {
  it("is a level-1 builtin targeting the current workspace by default", () => {
    assert.equal(renameWorkspaceDefinition.name, "rename_workspace");
    assert.equal(renameWorkspaceDefinition.defaultPermissionLevel, 1);
    const schema = renameWorkspaceDefinition.parameters as {
      required?: string[];
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    assert.deepEqual(schema.required, ["name"]);
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.properties?.workspace_id);
    assert.ok(schema.properties?.workspace_path);
    assert.match(renameWorkspaceDefinition.description, /sessions are unchanged/i);
  });

  it("is wired into catalog, registry, summaries, icon catalog and both hosts", () => {
    const read = (rel: string) =>
      readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(read("../types.ts"), /\| "rename_workspace"/);
    assert.match(read("../catalog.ts"), /rename_workspace: "filesystem"/);
    assert.match(
      read("../index.ts"),
      /registerBuiltin\(renameWorkspaceDefinition, renameWorkspaceHandler\)/,
    );
    assert.match(read("../displayMeta.ts"), /rename_workspace: \{/);
    assert.match(read("../executionSummaries.ts"), /rename_workspace: \(/);
    assert.match(read("../uiDescriptions.ts"), /rename_workspace:/);
    assert.match(
      read("../../shared/icons/toolIconCatalog.ts"),
      /"rename_workspace":/,
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

describe("rename_workspace handler", () => {
  it("reports a usable error when no host installed the port", async () => {
    const res = await run({ name: "Demo" }, ctx());
    assert.equal(res.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(res), /unavailable in this host/i);
  });

  it("rejects invalid target arguments before touching the port", async () => {
    const { manager, calls } = fakePort();
    for (const args of [
      {},
      { name: "  " },
      { name: "Demo", workspace_id: "a", workspace_path: "/tmp/a" },
      { name: "Demo", workspace_path: "relative" },
    ]) {
      const res = await run(args, ctx({ workspaceManager: manager }));
      assert.equal(res.returnCode, ToolReturnCode.InvalidArguments);
    }
    const noTarget = await run(
      { name: "Demo" },
      ctx({ workspaceManager: manager, workspaceId: undefined }),
    );
    assert.equal(noTarget.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(calls.length, 0);
  });

  it("uses the current workspace when no target is given", async () => {
    const { manager, calls } = fakePort();
    const res = await run({ name: " MCP Tools " }, ctx({ workspaceManager: manager }));
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.deepEqual(calls, [{ id: "current-id", name: "MCP Tools" }]);
    assert.match(text(res), /workspace renamed: MCP Tools \(was Demo\)/);
    assert.match(text(res), /current session workspace unchanged/);
  });

  it("renames an explicit workspace id and an absolute workspace path", async () => {
    const { manager, calls } = fakePort();
    await run(
      { name: "Renamed", workspace_id: "ws-2" },
      ctx({ workspaceManager: manager }),
    );
    const target = resolve("/srv/jellybot-agent/workspaces/legacy");
    await run(
      { name: "From path", workspace_path: target },
      ctx({ workspaceManager: manager }),
    );
    assert.deepEqual(calls, [
      { id: "ws-2", name: "Renamed" },
      { path: target, name: "From path" },
    ]);
  });

  it("honours the path guard and surfaces port failures", async () => {
    const { manager } = fakePort();
    const denied = await run(
      { name: "Demo", workspace_path: "/tmp/demo" },
      ctx({
        workspaceManager: manager,
        assertPath: () => {
          throw new Error("project excluded");
        },
      }),
    );
    assert.equal(denied.returnCode, ToolReturnCode.PermissionDenied);
    assert.match(text(denied), /project excluded/);

    const failing: WorkspaceManagerPort = {
      create: async () => {
        throw new Error("create denied");
      },
      rename: async () => {
        throw new Error("not registered");
      },
    };
    const failed = await run(
      { name: "Demo" },
      ctx({ workspaceManager: failing }),
    );
    assert.equal(failed.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(failed), /not registered/);
  });

  it("falls back to the globally configured port", async () => {
    const { manager, calls } = fakePort();
    configureWorkspaceManager(manager);
    const res = await run({ name: "Headless" }, ctx({ workspaceId: undefined }));
    assert.equal(res.returnCode, ToolReturnCode.InvalidArguments);

    const withId = await run(
      { name: "Headless", workspace_id: "ws-9" },
      ctx({ workspaceId: undefined }),
    );
    assert.equal(withId.returnCode, ToolReturnCode.Success);
    assert.deepEqual(calls, [{ id: "ws-9", name: "Headless" }]);
  });
});
