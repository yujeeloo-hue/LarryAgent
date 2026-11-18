#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const testTimeoutMs = Number(process.env.JB_TEST_TIMEOUT_MS ?? 120_000);
const wallTimeoutMs = Number(process.env.JB_TEST_WALL_MS ?? 10 * 60_000);

function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(relative(root, full));
    }
  }
  return out;
}

function runningTestFiles(pid) {
  try {
    const listing = process.platform === "win32"
      ? execFileSync("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ProcessId -ne ${pid} } | ForEach-Object { $_.CommandLine }`],
      { encoding: "utf8" })
      : execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });
    const files = new Set();
    for (const line of listing.split(/\r?\n/)) {
      if (/\s--test(\s|$)/.test(line)) continue;
      const match = line.match(/(\S+\.test\.ts)\s*$/);
      if (match) files.add(relative(root, match[1]) || match[1]);
    }
    return [...files];
  } catch {
    return [];
  }
}

function killTree(child) {
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {  }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

const filter = process.argv[2];
let files = collectTestFiles(join(root, "src")).sort();
if (filter) {
  files = files.filter((f) => f.toLowerCase().includes(filter.toLowerCase()));
}

if (files.length === 0) {
  console.error("No test files matched.");
  process.exit(1);
}

console.log(`Running ${files.length} test files${filter ? ` (filter: ${filter})` : ""}…`);

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", `--test-timeout=${testTimeoutMs}`, "--test-reporter=spec", ...files],
  { stdio: "inherit", cwd: root, shell: false, detached: process.platform !== "win32" },
);

const watchdog = setTimeout(() => {
  const stuck = runningTestFiles(child.pid);
  console.error(`\n[run-tests] still running after ${Math.round(wallTimeoutMs / 1000)}s — killing the run.`);
  if (stuck.length > 0) console.error(`[run-tests] stuck test files:\n  ${stuck.join("\n  ")}`);
  killTree(child);
  process.exit(124);
}, wallTimeoutMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killTree(child);
    process.exit(130);
  });
}

child.on("exit", (code) => {
  clearTimeout(watchdog);
  process.exit(code ?? 1);
});
