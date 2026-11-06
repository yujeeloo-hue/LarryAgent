#!/usr/bin/env node
/**
 * Cross-platform electron-vite launcher (Windows v1).
 *
 * `env -u ELECTRON_RUN_AS_NODE electron-vite …` is POSIX-only; this wrapper
 * removes the variable in-process and re-spawns the repo-local electron-vite
 * with the same args, so `npm run dev` / `npm run preview` behave
 * identically on macOS and Windows. Resolves node_modules/.bin directly so
 * it also works when invoked outside an npm script (no .bin in PATH).
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node run-electron-vite.mjs <dev|preview|build> [...]");
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const bin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-vite.cmd" : "electron-vite",
);

const child = spawn(bin, args, {
  stdio: "inherit",
  env,
  // Windows runs the .cmd shim — needs a shell; POSIX shebang scripts don't.
  shell: process.platform === "win32",
});

child.on("error", (err) => {
  console.error(
    `[run-electron-vite] failed to start electron-vite: ${err.message}`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
