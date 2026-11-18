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

mkdirSync(outDir, { recursive: true });
const result = await build({
  entryPoints: [join(root, "src/agentd/main.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: bundlePath,
  external: ["node:*", "electron", "fsevents"],
  metafile: true,
  sourcemap: false,
  minify: false,
  banner: {
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
  console.warn(
    `[agentd] ⚠ vendored node cannot execute on this host (${nodeOutput.error?.message ?? nodeOutput.status}) — arch check skipped`,
  );
} else if (!(nodeOutput.stdout ?? "").includes(NODE_VERSION)) {
  fail(`vendored node reports ${(nodeOutput.stdout ?? "").trim()}, expected ${NODE_VERSION}`);
}

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

const tarballPath = join(distDir, `${stageName}.tar.gz`);
rmSync(tarballPath, { force: true });
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
