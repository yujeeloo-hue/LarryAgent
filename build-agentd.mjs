/**
 * Build the jellybot-agentd release — self-contained headless bundle for
 * linux-arm64 (Raspberry Pi OS Bookworm), shipped with a vendored Node.js so
 * the device needs no system node/npm.
 *
 * Usage: node build-agentd.mjs [--skip-node] [--skip-smoke] [--node-version vX.Y.Z]
 *
 * Output (dist/agentd/):
 *   jellybot-agentd-<version>-linux-arm64/            assembled tree
 *   jellybot-agentd-<version>-linux-arm64.tar.gz      release tarball
 *   jellybot-agentd-<version>-linux-arm64.tar.gz.sha256
 *
 * Guards:
 * 1. ELECTRON-FREE GRAPH — the bundle must stay runnable under plain Node
 *    (no Electron binary). esbuild's metafile is scanned for STATIC
 *    `electron` imports (import-statement / require-call) and any
 *    node_modules/electron input; the final bundle text is re-checked for
 *    `from "electron"` / `require("electron")`. Dynamic `import("electron")`
 *    is allowed — the credential store probes safeStorage and degrades to
 *    plaintext outside Electron.
 * 2. DESKTOP SHELL — src/main/index.ts (and with it the tray/windows/IPC
 *    graph) must never be reachable from the headless entry.
 * 3. BOOT SMOKE — the built bundle is booted (`agentd run`) against throwaway
 *    config/data dirs with an 8s timeout; a missing banner fails the build.
 */
import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

const args = process.argv.slice(2);
const skipNode = args.includes("--skip-node");
const skipSmoke = args.includes("--skip-smoke");
const nodeVersionArg = args.find((a) => a.startsWith("--node-version="));
const NODE_VERSION =
  nodeVersionArg?.split("=")[1] ??
  process.env.JELLYBOT_AGENTD_NODE_VERSION?.trim() ??
  "v22.22.2";
const NODE_ARCH = "linux-arm64";
/** Download/extract cache (rebuild-friendly; safe to clean). */
const NODE_CACHE = "/tmp/jb-agentd/node-cache";

const outDir = join(root, "out", "agentd");
const distDir = join(root, "dist", "agentd");
const stageName = `jellybot-agentd-${version}-${NODE_ARCH}`;
const stageDir = join(distDir, stageName);
const bundlePath = join(outDir, "agentd.mjs");

function fail(message) {
  console.error(`[agentd] ✖ ${message}`);
  process.exit(1);
}

// ── 1. Bundle ─────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const result = await build({
  entryPoints: [join(root, "src/agentd/main.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: bundlePath,
  // No `electron` alias on purpose: a static import must fail the guard
  // below, not silently resolve to a shim.
  external: ["node:*", "electron", "fsevents"],
  metafile: true,
  sourcemap: false,
  minify: false,
  banner: {
    // CJS deps (ws etc.) call require() — provide it in ESM output.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});
console.log(
  `[agentd] bundled ${(statSync(bundlePath).size / 1024 / 1024).toFixed(1)} MB → ${bundlePath}`,
);

// ── 2. Guards ─────────────────────────────────────────────────
const staticElectron = [];
const electronInputs = [];
const desktopShell = [];
for (const [input, meta] of Object.entries(result.metafile.inputs)) {
  if (/node_modules[\\/]electron[\\/]/.test(input)) electronInputs.push(input);
  if (/src[\\/]main[\\/]index\.ts$/.test(input)) desktopShell.push(input);
  for (const imp of meta.imports ?? []) {
    if (imp.path !== "electron") continue;
    if (imp.kind === "import-statement" || imp.kind === "require-call") {
      staticElectron.push(`${input} (${imp.kind})`);
    }
  }
}
const bundleText = readFileSync(bundlePath, "utf8");
// Anchored (line-start) patterns only: real ESM static imports sit at the
// start of a line, while template-string leftovers (workspace/templates.ts
// ships an Electron scaffold as a string literal) never do.
const staticText = [
  {
    pattern: /^\s*import\s+[^\n]*from\s*["']electron["']\s*;?\s*$/m,
    label: 'static import from "electron"',
  },
  {
    pattern: /^\s*import\s*["']electron["']\s*;?\s*$/m,
    label: 'side-effect import "electron"',
  },
];
for (const { pattern, label } of staticText) {
  const match = pattern.exec(bundleText);
  if (match) {
    staticElectron.push(`bundle text — ${label} at offset ${match.index}`);
  }
}
if (staticElectron.length > 0) {
  console.error("[agentd] ✖ ELECTRON-FREE GUARD FAILED — static electron usage reached the headless bundle:");
  for (const line of staticElectron.slice(0, 20)) console.error(`    ${line}`);
  process.exit(1);
}
if (electronInputs.length > 0) {
  fail(`electron package got bundled: ${electronInputs.join(", ")}`);
}
if (desktopShell.length > 0) {
  fail(`desktop shell (src/main/index.ts) is reachable from the headless entry: ${desktopShell.join(", ")}`);
}
console.log("[agentd] guard ok — no static electron imports, no desktop shell in the graph");

// ── 3. Boot smoke (throwaway dirs, 8s, SIGTERM) ───────────────
// Async spawn + explicit SIGTERM: spawnSync's timeout kill bypasses the
// child's signal handlers (reports exit 1, zero graceful-shutdown logs).
if (!skipSmoke) {
  const smokeBase = join("/tmp/jb-agentd", `smoke-${process.pid}`);
  const smokeConfig = join(smokeBase, "config");
  const smokeData = join(smokeBase, "data");
  mkdirSync(smokeConfig, { recursive: true });
  mkdirSync(smokeData, { recursive: true });
  const child = spawn(process.execPath, [bundlePath, "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      JELLYBOT_AGENTD_CONFIG_DIR: smokeConfig,
      JELLYBOT_AGENTD_DATA_DIR: smokeData,
    },
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const killTimer = setTimeout(() => child.kill("SIGTERM"), 8000);
  const hardTimer = setTimeout(() => child.kill("SIGKILL"), 20000);
  const { code, signal } = await new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  clearTimeout(killTimer);
  clearTimeout(hardTimer);
  rmSync(smokeBase, { recursive: true, force: true });
  const banner = out.includes(`jellybot-agentd ${version}`);
  const stopped = out.includes("shutting down") && out.includes("stopped");
  // Windows cannot deliver a catchable SIGTERM to a child process
  // (child.kill("SIGTERM") terminates unconditionally and the child's
  // handler never runs), so the graceful-shutdown leg is POSIX-only.
  // The boot proof (banner) stays mandatory on every platform.
  const gracefulOk = stopped && code === 0;
  const windowsAccepted = process.platform === "win32" && banner;
  if (!banner || (!gracefulOk && !windowsAccepted)) {
    console.error(out.trim().slice(-4000));
    fail(
      `boot smoke failed — banner=${banner} cleanShutdown=${stopped} (exit ${code}, signal ${signal})`,
    );
  }
  console.log(
    process.platform === "win32"
      ? "[agentd] boot smoke ok — banner boot proven; clean SIGTERM shutdown is POSIX-only (accepted on win32)"
      : "[agentd] boot smoke ok — clean SIGTERM shutdown",
  );
} else {
  console.log("[agentd] boot smoke skipped (--skip-smoke)");
}

// ── 4. Vendored Node ──────────────────────────────────────────
function ensureVendoredNode() {
  const dir = join(NODE_CACHE, `node-${NODE_VERSION}-${NODE_ARCH}`);
  const nodeBin = join(dir, "bin", "node");
  if (existsSync(nodeBin)) return nodeBin;
  if (skipNode) {
    fail(`--skip-node set but no cached node at ${nodeBin}`);
  }
  return null;
}

async function downloadVendoredNode() {
  const dir = join(NODE_CACHE, `node-${NODE_VERSION}-${NODE_ARCH}`);
  const fileBase = `node-${NODE_VERSION}-${NODE_ARCH}`;
  mkdirSync(dir, { recursive: true });
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${fileBase}.tar.xz`;
  console.log(`[agentd] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) fail(`node download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const tarPath = join(dir, `${fileBase}.tar.xz`);
  writeFileSync(tarPath, bytes);
  try {
    const sumsResponse = await fetch(
      `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`,
    );
    if (sumsResponse.ok) {
      const sums = await sumsResponse.text();
      const line = sums
        .split("\n")
        .find((l) => l.trim().endsWith(`${fileBase}.tar.xz`));
      if (line) {
        const expected = line.trim().split(/\s+/)[0].toLowerCase();
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== expected) {
          fail(`node tarball sha256 mismatch (${actual} != ${expected})`);
        }
        console.log(`[agentd] node sha256 verified (${actual})`);
      }
    }
  } catch {
    console.warn("[agentd] ⚠ could not verify node sha256 (SHASUMS fetch failed)");
  }
  const extracted = spawnSync("tar", ["-xJf", tarPath, "-C", dir]);
  if (extracted.error || extracted.status !== 0) {
    fail(`node extract failed: ${extracted.error?.message ?? `exit ${extracted.status}`}`);
  }
  return join(dir, fileBase, "bin", "node");
}

let nodeBin = ensureVendoredNode();
if (!nodeBin) {
  nodeBin = await downloadVendoredNode();
  console.log(`[agentd] vendored node ready → ${nodeBin}`);
}
const nodeDir = dirname(dirname(nodeBin));
const nodeOutput = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
if (nodeOutput.status !== 0) {
  // Cross-arch cache (testing): the binary cannot run on this host.
  console.warn(
    `[agentd] ⚠ vendored node cannot execute on this host (${nodeOutput.error?.message ?? nodeOutput.status}) — arch check skipped`,
  );
} else if (!(nodeOutput.stdout ?? "").includes(NODE_VERSION)) {
  fail(`vendored node reports ${(nodeOutput.stdout ?? "").trim()}, expected ${NODE_VERSION}`);
}

// ── 5. Assemble stage ─────────────────────────────────────────
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(join(stageDir, "bin"), { recursive: true });
mkdirSync(join(stageDir, "lib", "node", "bin"), { recursive: true });
mkdirSync(join(stageDir, "resources"), { recursive: true });
mkdirSync(join(stageDir, "systemd"), { recursive: true });

copyFileSync(bundlePath, join(stageDir, "lib", "agentd.mjs"));
copyFileSync(
  join(root, "src/agentd/packaging/agentd-launcher.sh"),
  join(stageDir, "bin", "agentd"),
);
chmodSync(join(stageDir, "bin", "agentd"), 0o755);
cpSync(join(root, "resources", "prompts"), join(stageDir, "resources", "prompts"), {
  recursive: true,
});
copyFileSync(
  join(root, "src/agentd/packaging/jellybot-agentd.service"),
  join(stageDir, "systemd", "jellybot-agentd.service"),
);
copyFileSync(
  join(root, "src/agentd/packaging/jellybot-agentd-update.path"),
  join(stageDir, "systemd", "jellybot-agentd-update.path"),
);
copyFileSync(
  join(root, "src/agentd/packaging/jellybot-agentd-update.service"),
  join(stageDir, "systemd", "jellybot-agentd-update.service"),
);
copyFileSync(
  join(root, "src/agentd/packaging/jellybot-agentd-reboot.path"),
  join(stageDir, "systemd", "jellybot-agentd-reboot.path"),
);
copyFileSync(
  join(root, "src/agentd/packaging/jellybot-agentd-reboot.service"),
  join(stageDir, "systemd", "jellybot-agentd-reboot.service"),
);
copyFileSync(
  join(root, "src/agentd/packaging/README-agentd.md"),
  join(stageDir, "README.md"),
);
copyFileSync(nodeBin, join(stageDir, "lib", "node", "bin", "node"));
chmodSync(join(stageDir, "lib", "node", "bin", "node"), 0o755);
const nodeLicense = join(nodeDir, "LICENSE");
if (existsSync(nodeLicense)) {
  copyFileSync(nodeLicense, join(stageDir, "lib", "node", "LICENSE"));
}
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify(
    {
      name: "jellybot-agentd",
      version,
      private: true,
      description: "JellyBot headless agent node (linux-arm64), self-contained with vendored Node.js",
    },
    null,
    2,
  )}\n`,
);

// ── 6. Tarball + sha256 ───────────────────────────────────────
const tarballPath = join(distDir, `${stageName}.tar.gz`);
rmSync(tarballPath, { force: true });
// macOS bsdtar would otherwise embed extended attributes (AppleDouble ._*
// entries) and local uid/gid — strip all of that so the release extracts
// clean on Linux.
const tarArgs = ["-czf", tarballPath];
if (process.platform === "darwin") {
  tarArgs.push(
    "--no-mac-metadata",
    "--uid",
    "0",
    "--gid",
    "0",
    "--uname",
    "root",
    "--gname",
    "root",
  );
}
tarArgs.push("-C", distDir, stageName);
const tar = spawnSync("tar", tarArgs, {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
if (tar.error || tar.status !== 0) {
  fail(`tar failed: ${tar.error?.message ?? `exit ${tar.status}`}`);
}
const sha = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
writeFileSync(`${tarballPath}.sha256`, `${sha}  ${stageName}.tar.gz\n`);

console.log("");
console.log(`[agentd] ✔ release ready`);
console.log(`    stage   : ${stageDir}`);
console.log(`    tarball : ${tarballPath} (${(statSync(tarballPath).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`    sha256  : ${sha}`);
