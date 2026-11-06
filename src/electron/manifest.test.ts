import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { findElectronManifest, recipeFromPackage } from "./manifest.js";
import { breakpointLane } from "./breakpointLane.js";
import { parseElectronDebugConfig } from "./debugConfig.js";
import { resolveElectronLaunchContext } from "./launchContext.js";
import {
  electronSpawnPlan,
  electronViteCliJs,
  unixPathWithNodeLookup,
} from "./recipes.js";

async function writePkg(
  dir: string,
  pkg: unknown,
  extraFiles: string[] = [],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
  for (const name of extraFiles) {
    await writeFile(join(dir, name), "// config\n");
  }
}

describe("recipeFromPackage", () => {
  it("prefers electron-vite over classic electron", () => {
    assert.equal(
      recipeFromPackage(
        {
          devDependencies: { electron: "43", "electron-vite": "5" },
        },
        [],
      ),
      "electron-vite",
    );
  });

  it("detects electron-vite from config filename", () => {
    assert.equal(
      recipeFromPackage({ dependencies: { electron: "1" } }, [
        "electron.vite.config.ts",
      ]),
      "electron-vite",
    );
  });

  it("detects classic electron from dependencies", () => {
    assert.equal(
      recipeFromPackage({ dependencies: { electron: "38.0.0" } }, []),
      "electron",
    );
  });

  it("ignores unrelated package.json", () => {
    assert.equal(recipeFromPackage({ name: "lib", dependencies: { ws: "1" } }, []), null);
  });
});

describe("findElectronManifest", () => {
  it("finds a nested electron-vite app two directories down", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-e-man-"));
    try {
      const app = join(root, "apps", "desktop");
      await writePkg(app, {
        name: "desk",
        main: "./out/main/index.js",
        devDependencies: { electron: "43", "electron-vite": "5" },
      });
      const hit = findElectronManifest(root);
      assert.ok(hit);
      assert.equal(hit!.recipe, "electron-vite");
      assert.equal(hit!.packageName, "desk");
      assert.equal(hit!.projectRoot, app);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips node_modules and dist", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-e-skip-"));
    try {
      await writePkg(join(root, "node_modules", "electron"), {
        name: "electron",
        dependencies: { electron: "1" },
      });
      await writePkg(join(root, "dist"), {
        name: "packed",
        dependencies: { electron: "1" },
      });
      assert.equal(findElectronManifest(root), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("breakpointLane", () => {
  const root = "E:/app";
  it("routes main / renderer / preload", () => {
    assert.equal(breakpointLane("E:/app/src/main/index.ts", root), "main");
    assert.equal(
      breakpointLane("E:/app/src/renderer/src/App.ts", root),
      "renderer",
    );
    assert.equal(breakpointLane("E:/app/src/preload/index.ts", root), "all");
    assert.equal(breakpointLane("E:/app/electron.vite.config.ts", root), "main");
    assert.equal(breakpointLane("E:/app/shared/util.ts", root), "all");
  });
});

describe("parseElectronDebugConfig", () => {
  it("rejects unknown keys", () => {
    const res = parseElectronDebugConfig(
      { version: 1, electron: { foo: 1 } },
      "E:/app",
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /Unknown electron key "foo"/);
  });

  it("resolves relative runtimeExecutable", () => {
    const res = parseElectronDebugConfig(
      {
        version: 1,
        electron: { runtimeExecutable: "node_modules/.bin/electron-vite" },
      },
      "E:/app",
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.match(
        res.electron?.runtimeExecutable?.replace(/\\/g, "/") ?? "",
        /node_modules\/\.bin\/electron-vite$/,
      );
    }
  });
});

describe("resolveElectronLaunchContext + spawn plan", () => {
  it("builds electron-vite argv with inspect and REMOTE_DEBUGGING_PORT on Windows", {
    skip: process.platform !== "win32" && "Requires Windows Electron filesystem layout",
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-e-ctx-"));
    try {
      await writePkg(root, {
        name: "jelly",
        main: "./out/main/index.js",
        devDependencies: { electron: "43", "electron-vite": "5" },
      });
      await mkdir(join(root, "src", "renderer"), { recursive: true });
      const electronExe = join(root, "node_modules", "electron", "dist", "electron.exe");
      const viteCmd = join(root, "node_modules", ".bin", "electron-vite.cmd");
      const viteBin = join(root, "node_modules", ".bin", "electron-vite");
      await mkdir(join(root, "node_modules", "electron", "dist"), { recursive: true });
      await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
      await writeFile(electronExe, "");
      await writeFile(viteCmd, "");
      await writeFile(viteBin, "");

      const res = await resolveElectronLaunchContext(root, { platform: "win32" });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.context.recipe, "electron-vite");
      const plan = electronSpawnPlan(
        res.context,
        { inspectPort: 19229, remoteDebugPort: 19222 },
        "win32",
      );
      assert.equal(plan.shell, true);
      assert.match(plan.executable.replace(/\\/g, "/"), /electron-vite\.cmd$/);
      assert.deepEqual(plan.args, ["dev", "--sourcemap"]);
      assert.equal(plan.env.V8_INSPECTOR_PORT, "19229");
      assert.equal(plan.env.REMOTE_DEBUGGING_PORT, "19222");
      assert.equal(plan.env.JELLYBOT_DEBUGGEE, "1");
      assert.match(plan.env.ELECTRON_CLI_ARGS ?? "", /remote-allow-origins/);
      assert.match(plan.env.ELECTRON_CLI_ARGS ?? "", /electron-debug-profile/);
      assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.ok(!plan.args.some((arg) => arg.includes("inspect")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strips host Electron env and launches electron-vite via node on macOS", {
    skip: process.platform !== "darwin" && "Requires macOS Electron filesystem paths",
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-e-mac-"));
    try {
      await writePkg(root, {
        name: "jelly",
        main: "./out/main/index.js",
        devDependencies: { electron: "43", "electron-vite": "5" },
      });
      const electronBin = join(
        root,
        "node_modules",
        "electron",
        "dist",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron",
      );
      const viteBin = join(root, "node_modules", ".bin", "electron-vite");
      const viteCli = electronViteCliJs(root);
      const nodeBin = join(root, "fake-node-bin", "node");
      await mkdir(join(root, "src", "renderer"), { recursive: true });
      await mkdir(dirname(electronBin), { recursive: true });
      await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
      await mkdir(dirname(viteCli), { recursive: true });
      await mkdir(dirname(nodeBin), { recursive: true });
      await writeFile(electronBin, "");
      await writeFile(viteBin, "");
      await writeFile(viteCli, "#!/usr/bin/env node\n");
      await writeFile(nodeBin, "");

      const res = await resolveElectronLaunchContext(root, { platform: "darwin" });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      const plan = electronSpawnPlan(res.context, {
        inspectPort: 19229,
        remoteDebugPort: 19222,
      }, {
        platform: "darwin",
        home: root,
        exists: (path) =>
          path === nodeBin || path === viteCli || path === electronBin || path === viteBin,
        sourceEnv: {
          PATH: `${join(root, "fake-node-bin")}:/usr/bin:/bin`,
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_EXEC_PATH: "/Applications/Larry Agent.app/Contents/MacOS/Larry Agent",
          CHROME_CRASHPAD_PIPE_NAME: "mach-port-from-host",
          ELECTRON_CLI_ARGS: JSON.stringify(["--host-only-flag"]),
          NODE_OPTIONS: "--require /tmp/host-inject.js",
        },
      });
      assert.equal(plan.shell, false);
      assert.equal(plan.executable, nodeBin);
      assert.equal(plan.args[0], viteCli);
      assert.deepEqual(plan.args.slice(1), ["dev", "--sourcemap"]);
      assert.equal(plan.env.V8_INSPECTOR_PORT, "19229");
      assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(plan.env.ELECTRON_EXEC_PATH, undefined);
      assert.equal(plan.env.CHROME_CRASHPAD_PIPE_NAME, undefined);
      assert.equal(plan.env.NODE_OPTIONS, undefined);
      assert.equal(plan.env.ELECTRON_CLI_ARGS?.includes("host-only-flag"), false);
      assert.match(plan.env.ELECTRON_CLI_ARGS ?? "", /electron-debug-profile/);
      assert.match(plan.env.PATH ?? "", /opt\/homebrew\/bin/);
      assert.match(plan.env.PATH ?? "", /fake-node-bin/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepends Homebrew and version-manager bins to a GUI macOS PATH", () => {
    const path = unixPathWithNodeLookup("/usr/bin:/bin", "/Users/me");
    assert.match(path, /^\/opt\/homebrew\/bin:/);
    assert.match(path, /\/Users\/me\/\.volta\/bin/);
    assert.match(path, /\/usr\/bin:\/bin$/);
  });

  it("does not treat an Unreal workspace as Electron", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-e-ue-"));
    try {
      await writeFile(join(root, "Game.uproject"), "{}");
      await writePkg(root, { devDependencies: { electron: "1" } });
      const res = await resolveElectronLaunchContext(root);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, "unreal_project");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
