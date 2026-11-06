// Builds the relay-server payload bundled into the app's extraResources
// (see electron-builder.yml → resources/relay-server). The payload is what
// "one-click deploy" tars up and ships to a Linux server over SSH:
//   dist/            — compiled relay server (relay/src → relay/dist)
//   public/          — built web console (relay/web → relay/public)
//   package.json     — production manifest (ws only) for server-side npm install
// Run via: npm run build:relay
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname);
const relayDir = join(root, "relay");
const webDir = join(relayDir, "web");
const payloadDir = join(root, "resources", "relay-server");

function run(label, cmd, args, cwd, env) {
  console.log(`[build-relay] ${label}: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    console.error(`[build-relay] ${label} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

function ensureDeps(dir, label) {
  if (!existsSync(join(dir, "node_modules"))) {
    run(`${label} deps`, "npm", ["ci", "--no-audit", "--no-fund"], dir);
  }
}

// 1. Web console → relay/public (vite outDir, emptyOutDir). The deployed unit
// runs with RELAY_BASE_PATH=/relay (see src/main/relayDeployCore.ts), so the
// bundle must emit /relay/… asset URLs or the server 404s them.
ensureDeps(webDir, "web");
run("web build", "npm", ["run", "build"], webDir, {
  RELAY_BASE_PATH: process.env.RELAY_BASE_PATH ?? "/relay",
});

// 2. Relay server TS → relay/dist.
ensureDeps(relayDir, "relay");
run("relay build", "npm", ["run", "build"], relayDir);

// 3. Assemble the payload.
rmSync(payloadDir, { recursive: true, force: true });
mkdirSync(payloadDir, { recursive: true });
cpSync(join(relayDir, "dist"), join(payloadDir, "dist"), { recursive: true });
cpSync(join(relayDir, "public"), join(payloadDir, "public"), { recursive: true });
// Production manifest: strip dev tooling, keep only the runtime dependency.
const pkg = JSON.parse(readFileSync(join(relayDir, "package.json"), "utf8"));
delete pkg.scripts;
delete pkg.devDependencies;
delete pkg.engines;
cpSync(join(relayDir, "package-lock.json"), join(payloadDir, "package-lock.json"));
writeFileSync(join(payloadDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`[build-relay] payload → ${payloadDir}`);
