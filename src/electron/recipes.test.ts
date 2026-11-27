import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { describe, it } from "node:test";
import type { ElectronLaunchContext } from "./launchContext.js";
import { electronSpawnPlan, electronViteCliJs } from "./recipes.js";

describe("Electron spawn plan platform isolation", () => {
  for (const platform of ["darwin", "win32"] as const) {
    it(`builds a ${platform} plan without depending on the host filesystem`, () => {
      const paths = platform === "win32" ? win32 : posix;
      const root = platform === "win32" ? "C:\\workspace\\app" : "/workspace/app";
      const viteBin = paths.join(root, "node_modules", ".bin",
        platform === "win32" ? "electron-vite.cmd" : "electron-vite");
      const context: ElectronLaunchContext = {
        recipe: "electron-vite",
        projectRoot: root,
        manifestPath: paths.join(root, "package.json"),
        packageName: "app",
        main: "out/main/index.js",
        electronBin: "unused",
        viteBin,
        webRoot: root,
        outFiles: [],
        runtimeExecutable: viteBin,
        runtimeArgs: ["dev", "--sourcemap", "--inspect=9229"],
        stopOnEntry: false,
      };
      const cli = paths.join(root, "node_modules", "electron-vite", "bin", "electron-vite.js");
      assert.equal(electronViteCliJs(root, platform), cli);
      const plan = electronSpawnPlan(context, {
        inspectPort: 19229, remoteDebugPort: 19222,
      }, {
        platform,
        home: platform === "win32" ? "C:\\Users\\me" : "/Users/me",
        sourceEnv: {
          PATH: platform === "win32" ? "C:\\Node;C:\\Windows" : "/node-bin:/usr/bin:/bin",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_EXEC_PATH: "host-electron",
          CHROME_CRASHPAD_PIPE_NAME: "host-pipe",
          ELECTRON_CLI_ARGS: '["--host-only-flag"]',
          NODE_OPTIONS: "--require host-inject.js",
        },
        exists: (path) => path === "/node-bin/node" || path === cli,
      });
      assert.equal(plan.executable, platform === "win32" ? viteBin : "/node-bin/node");
      assert.deepEqual(plan.args, platform === "win32"
        ? ["dev", "--sourcemap"]
        : [cli, "dev", "--sourcemap"]);
      assert.equal(plan.shell, platform === "win32");
      assert.equal(plan.env.V8_INSPECTOR_PORT, "19229");
      assert.equal(plan.env.REMOTE_DEBUGGING_PORT, "19222");
      for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_EXEC_PATH", "CHROME_CRASHPAD_PIPE_NAME", "NODE_OPTIONS"]) {
        assert.equal(plan.env[key], undefined);
      }
      assert.deepEqual(JSON.parse(plan.env.ELECTRON_CLI_ARGS!), [
        "--remote-allow-origins=*",
        `--user-data-dir=${paths.join(root, ".larry", "electron-debug-profile")}`,
      ]);
    });
  }
});
