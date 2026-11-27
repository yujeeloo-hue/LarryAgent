import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  copyDebuggeeEnv,
  isHostDebugEnvKey,
  nvmNodeBinDirs,
  resolveNodeFromPath,
  unixPathWithNodeLookup,
} from "./debuggeeEnv.js";

describe("isHostDebugEnvKey", () => {
  it("strips Electron and Chromium pipes that crash a nested Chrome", () => {
    assert.equal(isHostDebugEnvKey("CHROME_CRASHPAD_PIPE_NAME"), true);
    assert.equal(isHostDebugEnvKey("ELECTRON_RUN_AS_NODE"), true);
    assert.equal(isHostDebugEnvKey("ELECTRON_EXEC_PATH"), true);
    assert.equal(isHostDebugEnvKey("NODE_OPTIONS"), true);
    assert.equal(isHostDebugEnvKey("PATH"), false);
    assert.equal(isHostDebugEnvKey("HOME"), false);
  });
});

describe("copyDebuggeeEnv", () => {
  it("preserves the Windows PATH key and separator without Unix lookup paths", () => {
    const env = copyDebuggeeEnv({
      Path: "C:\\Node;C:\\Windows\\System32",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect=9229",
    }, { platform: "win32", home: "C:\\Users\\me" });
    assert.deepEqual(env, { Path: "C:\\Node;C:\\Windows\\System32" });
  });

  it("drops host Chromium env and keeps PATH", () => {
    const env = copyDebuggeeEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/me",
        CHROME_CRASHPAD_PIPE_NAME: "mach-port",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--inspect=9229",
      },
      { platform: "darwin", home: "/Users/me" },
    );
    assert.equal(env.CHROME_CRASHPAD_PIPE_NAME, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.HOME, "/Users/me");
    assert.match(env.PATH ?? "", /opt\/homebrew\/bin/);
  });
});

describe("unixPathWithNodeLookup", () => {
  it("prepends Homebrew bins to a GUI macOS PATH", () => {
    const path = unixPathWithNodeLookup("/usr/bin:/bin", "/Users/me");
    assert.match(path, /^\/opt\/homebrew\/bin:/);
    assert.ok(path.split(":").includes("/Users/me/.volta/bin"));
    assert.ok(!path.includes("\\"));
    assert.match(path, /\/usr\/bin:\/bin$/);
  });
});

describe("Node lookup path conventions", () => {
  it("uses Unix paths for nvm, regardless of the host platform", () => {
    const dirs = nvmNodeBinDirs("/Users/me", (path) => {
      assert.equal(path, "/Users/me/.nvm/versions/node");
      return ["v20.1.0", "default", "v22.2.0"];
    });
    assert.deepEqual(dirs, [
      "/Users/me/.nvm/versions/node/v22.2.0/bin",
      "/Users/me/.nvm/versions/node/v20.1.0/bin",
    ]);
  });

  it("looks up a Unix node using colon-separated directories", () => {
    assert.equal(resolveNodeFromPath(
      ":/missing:/toolchain/bin",
      (path) => path === "/toolchain/bin/node",
      "darwin",
    ), "/toolchain/bin/node");
  });

  it("keeps Windows drive letters intact and looks up node.exe", () => {
    assert.equal(resolveNodeFromPath(
      "C:\\missing;D:\\Node Tools",
      (path) => path === "D:\\Node Tools\\node.exe",
      "win32",
    ), "D:\\Node Tools\\node.exe");
  });
});
