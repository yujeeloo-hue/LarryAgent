/**
 * taskConfigSuggest — import-time `.larry/tasks.json` generation matrix.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ensureDevTasksConfig,
  suggestDevTasks,
} from "./taskConfigSuggest.js";
import { parseDevTasksConfig } from "../main/devTaskConfig.js";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jb-tasksuggest-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writePkg(dir: string, pkg: unknown): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg), "utf8");
}

describe("suggestDevTasks", () => {
  it("electron-builder with dist:mac/dist:win writes both platform blocks", async () => {
    await withTempDir(async (dir) => {
      await writePkg(dir, {
        name: "app",
        main: "out/main/index.js",
        scripts: {
          build: "electron-vite build",
          dist: "electron-builder --config electron-builder.yml",
          "dist:mac": "electron-builder --mac",
          "dist:win": "electron-builder --win --x64",
          dev: "electron-vite dev",
        },
        devDependencies: { electron: "^43.0.0", "electron-builder": "^26.0.0", "electron-vite": "^5.0.0" },
      });
      const res = suggestDevTasks(dir);
      assert.ok(res);
      assert.equal(res.kind, "electron");
      const build = res.file.tasks.build!;
      assert.equal(build.command, "npm run dist");
      assert.equal(build.mac?.command, "npm run dist:mac");
      assert.equal(build.win?.command, "npm run dist:win");
      assert.equal(build.openAfter, "dist"); // electron-builder convention
      assert.equal(res.file.tasks.run?.command, "npm run dev");
      // The suggestion must itself be a valid config on both platforms.
      assert.equal(parseDevTasksConfig(res.file, dir, "darwin").ok, true);
      assert.equal(parseDevTasksConfig(res.file, dir, "win32").ok, true);
    });
  });

  it("vite web app: generic build, dist openAfter, kind web", async () => {
    await withTempDir(async (dir) => {
      await writePkg(dir, {
        name: "site",
        scripts: { build: "vite build", dev: "vite" },
        devDependencies: { vite: "^7.0.0" },
      });
      const res = suggestDevTasks(dir);
      assert.ok(res);
      assert.equal(res.kind, "web");
      assert.equal(res.file.tasks.build?.command, "npm run build");
      assert.equal(res.file.tasks.build?.openAfter, "dist");
      assert.equal(res.file.tasks.build?.mac, undefined);
      assert.equal(res.file.tasks.run?.command, "npm run dev");
    });
  });

  it("electron-builder.yml directories.output beats the dir probe", async () => {
    await withTempDir(async (dir) => {
      await writePkg(dir, {
        name: "app",
        scripts: { build: "electron-vite build", dist: "electron-builder", dev: "electron-vite dev" },
        devDependencies: { electron: "^43.0.0", "electron-builder": "^26.0.0", "electron-vite": "^5.0.0" },
      });
      await mkdir(join(dir, "out")); // electron-vite compile output must not win
      await writeFile(
        join(dir, "electron-builder.yml"),
        "directories:\n  buildResources: build\n  output: release\n",
        "utf8",
      );
      const res = suggestDevTasks(dir);
      assert.ok(res);
      assert.equal(res.file.tasks.build?.command, "npm run dist");
      assert.equal(res.file.tasks.build?.openAfter, "release");
    });
  });

  it("nested package.json (monorepo) gets cwd on every task", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "web"));
      await writePkg(join(dir, "web"), {
        name: "web",
        scripts: { dev: "concurrently npm:dev:*", build: "npm run build --workspace client" },
        devDependencies: { concurrently: "^9.0.0" },
      });
      const res = suggestDevTasks(dir);
      assert.ok(res);
      assert.equal(res.file.tasks.run?.command, "npm run dev");
      assert.equal(res.file.tasks.run?.cwd, "web");
      assert.equal(res.file.tasks.build?.command, "npm run build");
      assert.equal(res.file.tasks.build?.cwd, "web");
      // No web toolchain in this pkg's own deps and no output dir yet —
      // openAfter is honestly omitted rather than guessed.
      assert.equal(res.file.tasks.build?.openAfter, undefined);
    });
  });

  it("pnpm lockfile switches the runner and existing dist wins the probe", async () => {
    await withTempDir(async (dir) => {
      await writePkg(dir, {
        name: "app",
        scripts: { build: "vite build", start: "node server.js" },
        devDependencies: { vite: "^7.0.0" },
      });
      await writeFile(join(dir, "pnpm-lock.yaml"), "", "utf8");
      await mkdir(join(dir, "dist"));
      const res = suggestDevTasks(dir);
      assert.ok(res);
      assert.equal(res.file.tasks.build?.command, "pnpm run build");
      assert.equal(res.file.tasks.build?.openAfter, "dist");
      assert.equal(res.file.tasks.run?.command, "pnpm run start");
    });
  });

  it("node service without a build script gets run only", async () => {
    await withTempDir(async (dir) => {
      await writePkg(dir, {
        name: "srv",
        scripts: { dev: "node --watch server.js", start: "node server.js" },
        dependencies: { express: "^5.0.0" },
      });
      const res = suggestDevTasks(dir);
      assert.ok(res);
      assert.equal(res.kind, "node");
      assert.equal(res.file.tasks.build, undefined);
      assert.equal(res.file.tasks.run?.command, "npm run dev");
    });
  });

  it("package.json without scripts and unknown folders yield null", async () => {
    await withTempDir(async (dir) => {
      await writePkg(dir, { name: "empty" });
      assert.equal(suggestDevTasks(dir), null);
    });
    await withTempDir(async (dir) => {
      assert.equal(suggestDevTasks(dir), null);
    });
  });

  it("unreal project: empty config (UBT build is injected elsewhere)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "Game.uproject"), "{}", "utf8");
      const res = suggestDevTasks(dir);
      assert.ok(res);
      assert.equal(res.kind, "unreal");
      assert.deepEqual(res.file, { version: 1, tasks: {} });
    });
  });
});

describe("ensureDevTasksConfig", () => {
  it("creates once, then reports exists; unknown folders are skipped", async () => {
    await withTempDir(async (dir) => {
      await writePkg(dir, {
        name: "app",
        scripts: { dev: "vite", build: "vite build" },
        devDependencies: { vite: "^7.0.0" },
      });
      assert.equal(await ensureDevTasksConfig(dir), "created");
      const first = await readFile(join(dir, ".larry/tasks.json"), "utf8");
      assert.equal(await ensureDevTasksConfig(dir), "exists");
      // Idempotent — the second call did not rewrite the file.
      const second = await readFile(join(dir, ".larry/tasks.json"), "utf8");
      assert.equal(first, second);
    });
    await withTempDir(async (dir) => {
      assert.equal(await ensureDevTasksConfig(dir), "skipped");
    });
  });
});
