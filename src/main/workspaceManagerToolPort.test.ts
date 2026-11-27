import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createWorkspaceManagerPort } from "./workspaceManagerToolPort.js";
import type { SessionStore } from "./sessionRuntime.js";

let scratch: string | null = null;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

async function tempDir(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "jb-workspace-port-"));
  return scratch;
}

function fakeStore(
  existing: Array<{ id: string; name: string; path: string }> = [],
) {
  const created: Array<{ name: string; path: string }> = [];
  const renamed: Array<{ id: string; name: string }> = [];
  const store = {
    listWorkspaces: () => existing,
    createWorkspace: async (req: { name: string; path: string }) => {
      created.push(req);
      return {
        id: "new-id",
        name: req.name,
        path: req.path,
        origin: "user" as const,
        createdAt: 1,
        updatedAt: 1,
      };
    },
    updateWorkspace: async (req: { id: string; name: string }) => {
      renamed.push(req);
      const found = existing.find((workspace) => workspace.id === req.id);
      if (!found) throw new Error(`Unknown workspace: ${req.id}`);
      found.name = req.name;
      return { ...found, createdAt: 1, updatedAt: 2 };
    },
  };
  return {
    store: store as unknown as Pick<
      SessionStore,
      "listWorkspaces" | "createWorkspace" | "updateWorkspace"
    >,
    created,
    renamed,
  };
}

describe("workspaceManagerToolPort", () => {
  it("creates the directory then registers the workspace", async () => {
    const root = await tempDir();
    const target = join(root, "new-project");
    const { store, created } = fakeStore();
    const port = createWorkspaceManagerPort(store);

    const result = await port.create({ name: "Demo", path: target });

    assert.equal(result.existing, false);
    assert.equal(result.id, "new-id");
    assert.deepEqual(created, [{ name: "Demo", path: target }]);
    assert.equal((await stat(target)).isDirectory(), true);
  });

  it("reuses an already registered path without creating a duplicate", async () => {
    const root = await tempDir();
    const target = join(root, "existing-project");
    const { store, created } = fakeStore([
      { id: "old-id", name: "Existing", path: target },
    ]);
    const port = createWorkspaceManagerPort(store);

    const result = await port.create({ name: "Different name", path: target });

    assert.deepEqual(result, {
      id: "old-id",
      name: "Existing",
      path: target,
      existing: true,
    });
    assert.equal(created.length, 0);
  });

  it("refuses a path that exists as a file", async () => {
    const root = await tempDir();
    const target = join(root, "a-file.txt");
    await writeFile(target, "not a directory", "utf8");
    const { store, created } = fakeStore();
    const port = createWorkspaceManagerPort(store);

    await assert.rejects(
      () => port.create({ name: "Demo", path: target }),
      /not a folder/,
    );
    assert.equal(created.length, 0);
  });

  it("renames a registered workspace by id or path without changing its path", async () => {
    const target = "/srv/jellybot-agent/MCPHub";
    const { store, renamed } = fakeStore([
      { id: "ws-1", name: "MCPHub", path: target },
    ]);
    const port = createWorkspaceManagerPort(store);

    const byId = await port.rename({ id: "ws-1", name: " MCP Tools " });
    assert.deepEqual(renamed, [{ id: "ws-1", name: "MCP Tools" }]);
    assert.deepEqual(byId, {
      id: "ws-1",
      name: "MCP Tools",
      path: target,
      previousName: "MCP Tools",
    });

    await port.rename({ path: target, name: "Hub" });
    assert.deepEqual(renamed[1], { id: "ws-1", name: "Hub" });
  });

  it("refuses renaming an unregistered workspace", async () => {
    const { store, renamed } = fakeStore();
    const port = createWorkspaceManagerPort(store);
    await assert.rejects(
      () => port.rename({ path: "/srv/missing", name: "Missing" }),
      /not registered/,
    );
    assert.equal(renamed.length, 0);
  });
});
