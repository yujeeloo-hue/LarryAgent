import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { describe, it } from "node:test";
import {
  findWebManifest,
  isWebPackage,
  pickServerScript,
} from "./manifest.js";
import { webBreakpointLane } from "./breakpointLane.js";
import { parseWebDebugConfig } from "./debugConfig.js";
import { findChromeBinary } from "./chromeBinary.js";
import {
  parseAddressInUsePort,
  parseDevServerUrl,
  toChromePageUrl,
  waitForDevServerUrl,
} from "./devServerUrl.js";
import { resolveWebLaunchContext } from "./launchContext.js";
import type { WebLaunchContext } from "./launchContext.js";
import {
  directNodeScript,
  packageRunner,
  webServerSpawnPlan,
  chromeSpawnPlan,
} from "./recipes.js";

async function writePkg(
  dir: string,
  pkg: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
}

describe("isWebPackage", () => {
  it("detects express and vite apps", () => {
    assert.equal(
      isWebPackage({ dependencies: { express: "4" }, scripts: { start: "node server.js" } }, []),
      true,
    );
    assert.equal(
      isWebPackage({ devDependencies: { vite: "7" }, scripts: { dev: "vite" } }, []),
      true,
    );
  });

  it("rejects Electron apps", () => {
    assert.equal(
      isWebPackage(
        { devDependencies: { electron: "43", express: "4" }, scripts: { start: "electron ." } },
        [],
      ),
      false,
    );
  });

  it("rejects a plain library package", () => {
    assert.equal(isWebPackage({ name: "lib", dependencies: { ws: "1" } }, []), false);
  });

  it("detects a server.js file plus scripts", () => {
    assert.equal(
      isWebPackage({ scripts: { start: "node server.js" } }, ["server.js"]),
      true,
    );
  });
});

describe("pickServerScript", () => {
  it("prefers debug:server over generic start", () => {
    assert.equal(
      pickServerScript({ start: "node a", "debug:server": "node b", dev: "vite" }),
      "debug:server",
    );
  });
});

describe("findWebManifest", () => {
  it("finds a nested vite app two directories down", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-web-man-"));
    try {
      const app = join(root, "apps", "web");
      await writePkg(app, {
        name: "ethub-web",
        scripts: { dev: "vite" },
        devDependencies: { vite: "7" },
      });
      const hit = findWebManifest(root);
      assert.ok(hit);
      assert.equal(hit!.packageName, "ethub-web");
      assert.equal(hit!.projectRoot, app);
      assert.equal(hit!.script, "dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-web-skip-"));
    try {
      await writePkg(join(root, "node_modules", "vite"), {
        name: "vite",
        dependencies: { vite: "1" },
      });
      assert.equal(findWebManifest(root), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("webBreakpointLane", () => {
  const root = "E:/app";
  it("routes server vs client folders", () => {
    assert.equal(webBreakpointLane("E:/app/server/index.ts", root), "main");
    assert.equal(webBreakpointLane("E:/app/apps/web/src/App.tsx", root), "renderer");
    assert.equal(webBreakpointLane("E:/app/index.html", root), "renderer");
    assert.equal(webBreakpointLane("E:/app/shared/util.ts", root), "all");
  });
});

describe("parseWebDebugConfig", () => {
  it("rejects unknown keys", () => {
    const res = parseWebDebugConfig({ version: 1, web: { foo: 1 } }, "E:/app");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /Unknown web key "foo"/);
  });

  it("resolves relative chromeExecutable and keeps url", () => {
    const res = parseWebDebugConfig(
      {
        version: 1,
        web: { url: "http://127.0.0.1:3000", chromeExecutable: "chrome.exe" },
      },
      "E:/app",
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.web?.url, "http://127.0.0.1:3000");
      assert.match(res.web?.chromeExecutable?.replace(/\\/g, "/") ?? "", /chrome\.exe$/);
    }
  });

  it("ignores a sibling electron key", () => {
    const res = parseWebDebugConfig(
      { version: 1, electron: { stopOnEntry: true }, web: { script: "dev" } },
      "E:/app",
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.web?.script, "dev");
  });
});

describe("findChromeBinary", () => {
  it("returns the first existing candidate", () => {
    const hit = findChromeBinary({
      platform: "win32",
      env: { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      exists: (path) => path.endsWith("msedge.exe"),
    });
    assert.ok(hit);
    assert.match(hit!.replace(/\\/g, "/"), /msedge\.exe$/);
  });

  it("returns null when nothing is installed", () => {
    assert.equal(
      findChromeBinary({
        platform: "linux",
        exists: () => false,
      }),
      null,
    );
  });
});

describe("parseDevServerUrl", () => {
  it("parses Vite, Next, and port banners", () => {
    assert.equal(
      parseDevServerUrl("  ➜  Local:   http://localhost:5173/\n"),
      "http://localhost:5173/",
    );
    assert.equal(
      parseDevServerUrl("- Local:        http://localhost:3000\n"),
      "http://localhost:3000/",
    );
    assert.equal(
      parseDevServerUrl("Server listening on port 8080"),
      "http://127.0.0.1:8080/",
    );
  });

  it("parses Express-style 0.0.0.0 banners and ignores inspector noise", () => {
    assert.equal(
      parseDevServerUrl("listening on http://0.0.0.0:3000"),
      "http://0.0.0.0:3000/",
    );
    assert.equal(
      parseDevServerUrl("Server running at 0.0.0.0:8080"),
      "http://127.0.0.1:8080/",
    );
    assert.equal(
      parseDevServerUrl(
        "Debugger listening on ws://127.0.0.1:19229/uuid\nServer listening on port 3000",
      ),
      "http://127.0.0.1:3000/",
    );
    assert.equal(
      parseDevServerUrl("Debugger listening on ws://127.0.0.1:19229/uuid"),
      null,
    );
  });
});

describe("toChromePageUrl", () => {
  it("rewrites 0.0.0.0 to loopback", () => {
    assert.equal(toChromePageUrl("http://0.0.0.0:3000/"), "http://127.0.0.1:3000/");
  });
});

describe("waitForDevServerUrl", () => {
  it("opens Chrome from a listen-port probe when logs have no URL", async () => {
    let calls = 0;
    const url = await waitForDevServerUrl({
      timeoutMs: 2_000,
      intervalMs: 10,
      probeUrls: () => {
        calls += 1;
        return calls >= 2 ? ["http://127.0.0.1:3000/"] : [];
      },
      fetchImpl: async () => new Response("ok"),
    });
    assert.equal(url, "http://127.0.0.1:3000/");
  });

  it("fails fast when the server port is already taken", async () => {
    await assert.rejects(
      waitForDevServerUrl({
        timeoutMs: 10_000,
        intervalMs: 5,
        discoveredUrl: () => undefined,
        probeUrls: () => [],
        fetchImpl: async () => new Response("ok"),
        failFast: () => "Port 8888 is already in use (pid 42)",
      }),
      /Port 8888 is already in use/,
    );
  });

  it("fails fast while waiting on a configured URL too", async () => {
    await assert.rejects(
      waitForDevServerUrl({
        timeoutMs: 10_000,
        configuredUrl: "http://127.0.0.1:8888/",
        intervalMs: 5,
        fetchImpl: async () => {
          throw new Error("down");
        },
        failFast: () => "Port 8888 is already in use",
      }),
      /Port 8888 is already in use/,
    );
  });
});

describe("resolveWebLaunchContext + spawn plan", () => {
  it("builds npm run with NODE_OPTIONS inspect", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-web-ctx-"));
    try {
      await writePkg(root, {
        name: "ethub",
        scripts: { dev: "vite", start: "node server.js" },
        dependencies: { express: "4" },
        devDependencies: { vite: "7" },
      });
      const res = await resolveWebLaunchContext(root, {
        platform: "win32",
        findChrome: () => "C:\\chrome.exe",
      });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.context.chromeBin, "C:\\chrome.exe");
      const plan = webServerSpawnPlan(
        res.context,
        { inspectPort: 19229, remoteDebugPort: 19222 },
        {
          platform: "win32",
          sourceEnv: {
            PATH: "C:\\Windows",
            CHROME_CRASHPAD_PIPE_NAME: "pipe-from-host",
            ELECTRON_RUN_AS_NODE: "1",
            NODE_OPTIONS: "--require /tmp/host-inject.js",
          },
        },
      );
      assert.equal(plan.shell, true);
      assert.equal(plan.executable, "npm.cmd");
      assert.deepEqual(plan.args, ["run", "dev"]);
      assert.match(plan.env.NODE_OPTIONS ?? "", /--inspect=127\.0\.0\.1:19229/);
      assert.equal(plan.env.JELLYBOT_DEBUGGEE, "1");
      assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(plan.env.CHROME_CRASHPAD_PIPE_NAME, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not leak the host crashpad pipe into Chrome", () => {
    const plan = chromeSpawnPlan(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "http://127.0.0.1:5173/",
      19222,
      "/tmp/ethub",
      {
        platform: "darwin",
        home: "/tmp/ethub-home",
        sourceEnv: {
          PATH: "/usr/bin:/bin",
          CHROME_CRASHPAD_PIPE_NAME: "mach-port-from-host",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_EXEC_PATH: "/Applications/Larry Agent.app/Contents/MacOS/Larry Agent",
          NODE_OPTIONS: "--require /tmp/host-inject.js",
        },
      },
    );
    assert.equal(plan.env.CHROME_CRASHPAD_PIPE_NAME, undefined);
    assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(plan.env.ELECTRON_EXEC_PATH, undefined);
    assert.equal(plan.env.NODE_OPTIONS, undefined);
    assert.ok(plan.args.includes("--disable-crash-reporter"));
    assert.ok(plan.args.includes("--disable-breakpad"));
    assert.match(plan.args.join("\n"), /chrome-debug-profile/);
  });

  it("does not treat an Electron workspace as web", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-web-e-"));
    try {
      await writePkg(root, {
        name: "desk",
        scripts: { dev: "vite" },
        devDependencies: { electron: "43", vite: "7" },
      });
      const res = await resolveWebLaunchContext(root);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, "electron_project");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("picks pnpm when a lockfile is present", () => {
    const runner = packageRunner(
      "E:/app",
      (path) => path.replace(/\\/g, "/").endsWith("pnpm-lock.yaml"),
      "linux",
    );
    assert.equal(runner.executable, "pnpm");
    assert.deepEqual(runner.argsFor("dev"), ["run", "dev"]);
  });
});

describe("directNodeScript", () => {
  it("rewrites plain node scripts", () => {
    assert.deepEqual(directNodeScript("node --watch server.js"), {
      executable: "node",
      args: ["--watch", "server.js"],
    });
    assert.deepEqual(directNodeScript("  node server.js "), {
      executable: "node",
      args: ["server.js"],
    });
  });

  it("rejects wrappers, shell pipelines and quotes", () => {
    assert.equal(directNodeScript("vite"), null);
    assert.equal(directNodeScript("node"), null);
    assert.equal(directNodeScript("NODE_ENV=dev node server.js"), null);
    assert.equal(directNodeScript("node server.js && npm run build"), null);
    assert.equal(directNodeScript('node -e "console.log(1)"'), null);
  });
});

describe("parseAddressInUsePort", () => {
  it("reads the port from a listen EADDRINUSE crash", () => {
    assert.equal(
      parseAddressInUsePort(
        "Error: listen EADDRINUSE: address already in use 127.0.0.1:8888",
      ),
      8888,
    );
    assert.equal(
      parseAddressInUsePort(
        "Error: listen EADDRINUSE: address already in use 0.0.0.0:3000",
      ),
      3000,
    );
  });

  it("ignores inspector fallbacks and normal banners", () => {
    assert.equal(
      parseAddressInUsePort(
        "Starting inspector on 127.0.0.1:64703 failed: address already in use",
      ),
      null,
    );
    assert.equal(
      parseAddressInUsePort(
        "[boot] ETHub listening on http://127.0.0.1:8888",
      ),
      null,
    );
  });
});

describe("web launch with a plain node dev script", () => {
  for (const platform of ["darwin", "win32"] as const) {
    it(`prepends local bins using the ${platform} PATH separator on any host`, () => {
      const paths = platform === "win32" ? win32 : posix;
      const root = platform === "win32" ? "C:\\workspace\\app" : "/workspace/app";
      const bins = [paths.join(root, "node_modules", ".bin"), paths.join(root, "tools")];
      const pathKey = platform === "win32" ? "Path" : "PATH";
      const original = platform === "win32" ? "C:\\Node;C:\\Windows" : "/usr/bin:/bin";
      const context: WebLaunchContext = {
        projectRoot: root, manifestPath: paths.join(root, "package.json"),
        packageName: "app", webRoot: root, runtimeExecutable: "node",
        runtimeArgs: ["server.js"], pathPrepend: bins, shell: false,
        stopOnEntry: false, pageUrl: null, chromeBin: null,
      };
      const plan = webServerSpawnPlan(context, {
        inspectPort: 19229, remoteDebugPort: 19222,
      }, {
        platform, sourceEnv: { [pathKey]: original },
        home: platform === "win32" ? "C:\\Users\\me" : "/Users/me",
      });
      const pathEntries = plan.env[pathKey]!.split(paths.delimiter);
      assert.deepEqual(pathEntries.slice(0, bins.length), bins);
      assert.ok(plan.env[pathKey]!.endsWith(original));
      assert.equal(plan.shell, false);
    });
  }

  it("spawns node directly instead of npm run", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-web-node-"));
    try {
      await writePkg(root, {
        name: "ethub",
        scripts: { dev: "node --watch server.js" },
        dependencies: { express: "4" },
      });
      const res = await resolveWebLaunchContext(root, {
        platform: process.platform,
        findChrome: () => null,
      });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.context.runtimeExecutable, "node");
      assert.deepEqual(res.context.runtimeArgs, ["--watch", "server.js"]);
      assert.deepEqual(res.context.pathPrepend, [
        join(root, "node_modules", ".bin"),
      ]);
      const plan = webServerSpawnPlan(
        res.context,
        { inspectPort: 19229, remoteDebugPort: 19222 },
        {
          platform: process.platform,
          sourceEnv: { PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin" },
        },
      );
      assert.equal(plan.shell, false);
      assert.match(plan.args[0] ?? "", /^--inspect=127\.0\.0\.1:19229$/);
      assert.deepEqual(plan.args.slice(1), ["--watch", "server.js"]);
      assert.equal(plan.env.NODE_OPTIONS, undefined);
      assert.ok(
        (plan.env.PATH ?? "").startsWith(
          `${join(root, "node_modules", ".bin")}${delimiter}`,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps npm run for bin-style scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-web-vite-"));
    try {
      await writePkg(root, {
        name: "site",
        scripts: { dev: "vite" },
        devDependencies: { vite: "7" },
      });
      const res = await resolveWebLaunchContext(root, {
        platform: "darwin",
        findChrome: () => null,
      });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.context.runtimeExecutable, "npm");
      assert.deepEqual(res.context.runtimeArgs, ["run", "dev"]);
      assert.equal(res.context.pathPrepend, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
