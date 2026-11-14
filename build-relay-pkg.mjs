// Assemble the self-host relay tarball for the download site:
//
//   dist/relay-pkg/jellybot-relay-<RELAY_VERSION>.tar.gz   (+ .sha256 sidecar)
//
// Contents (top-level dir jellybot-relay-<v>/):
//   dist/  public/  node_modules/  package.json  package-lock.json
//   install.sh  jellybot-relay.service  VERSION
//
// The runtime deps (ws + adm-zip) are pure JavaScript, so one tarball serves
// linux x64 and arm64 alike — only the target host's own Node (>=22) is needed.
//
// A boot smoke is mandatory: the extracted bundle must serve /api/health with
// the expected version AND print the first-run console credential line before
// the tarball counts as built. Usage:
//
//   node build-relay-pkg.mjs [--skip-smoke]
//
// Requires `npm run build:relay` first (payload in resources/relay-server).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirnameOf(import.meta.url));
const payloadDir = join(root, "resources", "relay-server");
const outDir = join(root, "dist", "relay-pkg");
/** Rebuild-friendly dependency cache (safe to wipe). */
const CACHE = "/tmp/jb-relay-pkg";

function dirnameOf(url) {
  return resolve(fileURLToPath(url), "..");
}

function log(msg) {
  console.log(`[relay-pkg] ${msg}`);
}

function die(msg) {
  console.error(`[relay-pkg] ${msg}`);
  process.exit(1);
}

/** Same single source as scripts/release.mjs readRelayVersion(). */
function relayVersion() {
  const source = readFileSync(join(root, "relay", "src", "hub.ts"), "utf8");
  const match = /export const RELAY_VERSION = "([^"]+)"/.exec(source);
  return match?.[1] ?? null;
}

/** Grab a free TCP port for the smoke instance. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on("error", reject);
  });
}

async function smokeSafe(tarball, version) {
  try {
    await smoke(tarball, version);
    return true;
  } catch (err) {
    console.error(`[relay-pkg] ${err?.message ?? err}`);
    return false;
  }
}

async function smoke(tarball, version) {
  const tmp = mkdtempSync("/tmp/jb-relay-pkg-smoke.");
  try {
    spawnSync("tar", ["-xzf", tarball, "-C", tmp], { stdio: "ignore" });
    const top = readdirSync(tmp).map((name) => join(tmp, name)).find((p) => statSync(p).isDirectory());
    if (!top) throw new Error("smoke: tarball has no top-level directory");
    const port = await freePort();
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: top,
      env: {
        ...process.env,
        RELAY_HOST: "127.0.0.1",
        RELAY_PORT: String(port),
        RELAY_DATA_DIR: join(top, "smoke-data"),
        RELAY_PUBLIC_DIR: join(top, "public"),
        RELAY_BASE_PATH: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stdout += c));
    const stop = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    };
    try {
      const deadline = Date.now() + 20_000;
      let health = null;
      while (Date.now() < deadline && !health) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (res.ok) health = await res.json();
        } catch {
          /* booting */
        }
      }
      if (!health?.ok) throw new Error(`smoke: /api/health not ok after 20s\n${stdout.slice(-2000)}`);
      if (health.version !== version) throw new Error(`smoke: health version ${health.version} ≠ RELAY_VERSION ${version}`);
      // First-boot UX: the console credential must surface in the log.
      if (!/web console login: .+ \/ .+ /.test(stdout)) throw new Error("smoke: first-run credential line missing from stdout");
      log(`smoke ok — health v${health.version}, credential line printed`);
    } finally {
      stop();
      await new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.once("exit", r);
        setTimeout(r, 3000);
      });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---- 1. inputs ---------------------------------------------------------- */
const version = relayVersion();
if (!version) die('cannot read RELAY_VERSION from relay/src/hub.ts');
const payloadDist = join(payloadDir, "dist");
const payloadPublic = join(payloadDir, "public");
if (readdirSync(payloadDist).length === 0) die(`payload dist is empty: ${payloadDist} — run "npm run build:relay" first`);
if (!existsSync(join(payloadPublic, "index.html"))) die(`payload console missing: ${payloadPublic}/index.html`);
for (const f of ["install.sh", "jellybot-relay.service"]) {
  if (!existsSync(join(root, "relay", f))) die(`missing relay/${f}`);
}

/* ---- 2. stage ----------------------------------------------------------- */
const stageRoot = join(CACHE, "stage");
const stage = join(stageRoot, `jellybot-relay-${version}`);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const item of ["dist", "public", "package.json", "package-lock.json"]) {
  cpSync(join(payloadDir, item), join(stage, item), { recursive: true });
}
cpSync(join(root, "relay", "install.sh"), join(stage, "install.sh"));
chmodSync(join(stage, "install.sh"), 0o755);
cpSync(join(root, "relay", "jellybot-relay.service"), join(stage, "jellybot-relay.service"));
writeFileSync(join(stage, "VERSION"), `${version}\n`);

/* ---- 3. vendored node_modules (lock-pinned, cached) --------------------- */
const lockSha = createHash("sha256").update(readFileSync(join(stage, "package-lock.json"))).digest("hex");
const cacheDir = join(CACHE, `node-${lockSha}`);
if (!existsSync(join(cacheDir, "node_modules"))) {
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  cpSync(join(stage, "package.json"), join(cacheDir, "package.json"));
  cpSync(join(stage, "package-lock.json"), join(cacheDir, "package-lock.json"));
  log(`npm ci --omit=dev (lock ${lockSha.slice(0, 8)}…)`);
  const r = spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: cacheDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) die(`npm ci failed (exit ${r.status})`);
} else {
  log(`node_modules cache hit (lock ${lockSha.slice(0, 8)}…)`);
}
cpSync(join(cacheDir, "node_modules"), join(stage, "node_modules"), { recursive: true });
// No dev tooling may ride along.
const stagedPkg = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
if (stagedPkg.devDependencies && Object.keys(stagedPkg.devDependencies).length > 0) {
  die("staged package.json still carries devDependencies");
}

/* ---- 4. tarball + sidecar ---------------------------------------------- */
mkdirSync(outDir, { recursive: true });
const file = `jellybot-relay-${version}.tar.gz`;
const tarball = join(outDir, file);
// macOS Sequoia stamps com.apple.provenance onto every staged file (kernel
// managed — xattr -cr cannot remove it) and bsdtar embeds those as
// LIBARCHIVE.xattr headers that GNU tar warns about on every extract.
// python's tarfile ignores xattrs entirely; fall back to bsdtar where no
// python3 exists (warnings there are cosmetic).
const pyTar = spawnSync(
  "python3",
  [
    "-c",
    "import sys, tarfile\nt = tarfile.open(sys.argv[1], 'w:gz')\nt.add(sys.argv[2], arcname=sys.argv[3])\nt.close()",
    tarball,
    stage,
    basename(stage),
  ],
  { stdio: "inherit" },
);
let tar = pyTar;
if (pyTar.error || pyTar.status !== 0) {
  tar = spawnSync("tar", ["-czf", tarball, "-C", stageRoot, basename(stage)], { stdio: "inherit" });
}
if (tar.status !== 0) die(`tar failed (exit ${tar.status})`);
if (tar.status !== 0) die(`tar failed (exit ${tar.status})`);
const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(join(outDir, `${file}.sha256`), `${sha}  ${file}\n`);

/* ---- 5. smoke ----------------------------------------------------------- */
if (!process.argv.includes("--skip-smoke")) {
  const ok = await smokeSafe(tarball, version);
  if (!ok) {
    // Never leave a broken artifact behind for the manifest to pick up.
    rmSync(tarball, { force: true });
    rmSync(`${tarball}.sha256`, { force: true });
    die("smoke failed — broken tarball removed");
  }
}

log(`→ ${tarball} (${(statSync(tarball).size / 1024 / 1024).toFixed(1)} MB) sha256=${sha.slice(0, 16)}…`);
