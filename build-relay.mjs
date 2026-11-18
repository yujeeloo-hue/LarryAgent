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

ensureDeps(webDir, "web");
run("web build", "npm", ["run", "build"], webDir, {
  RELAY_BASE_PATH: process.env.RELAY_BASE_PATH ?? "/relay",
});

ensureDeps(relayDir, "relay");
run("relay build", "npm", ["run", "build"], relayDir);

rmSync(payloadDir, { recursive: true, force: true });
mkdirSync(payloadDir, { recursive: true });
cpSync(join(relayDir, "dist"), join(payloadDir, "dist"), { recursive: true });
cpSync(join(relayDir, "public"), join(payloadDir, "public"), { recursive: true });
const pkg = JSON.parse(readFileSync(join(relayDir, "package.json"), "utf8"));
delete pkg.scripts;
delete pkg.devDependencies;
delete pkg.engines;
cpSync(join(relayDir, "package-lock.json"), join(payloadDir, "package-lock.json"));
writeFileSync(join(payloadDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`[build-relay] payload → ${payloadDir}`);
