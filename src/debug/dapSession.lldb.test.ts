/**
 * Live lldb-dap: compile fixtures/sample.cpp and hit the BREAK line.
 * Skips when clang++ / lldb-dap are not on this machine.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DebugSession } from "./dapSession.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.cpp");

function breakLine(source: string): number {
  const lines = readFileSync(source, "utf8").split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes("// BREAK"));
  if (idx < 0) throw new Error(`${source} is missing // BREAK`);
  return idx + 1;
}

function testLldbDapPath(): string | null {
  const fromEnv = process.env.LARRY_LLDB_DAP_E2E?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const name = process.platform === "win32" ? "lldb-dap.exe" : "lldb-dap";
  if (process.platform === "win32") {
    const llvm = join("C:\\Program Files\\LLVM\\bin", name);
    if (existsSync(llvm)) return llvm;
  }
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(
    process.platform === "win32" ? ";" : ":",
  );
  for (const dir of dirs) {
    const candidate = join(dir.trim(), name);
    if (dir.trim() && existsSync(candidate)) return candidate;
  }
  return null;
}

function clangPath(): string | null {
  const exe =
    process.platform === "win32"
      ? join("C:\\Program Files\\LLVM\\bin", "clang++.exe")
      : "clang++";
  if (process.platform === "win32") return existsSync(exe) ? exe : null;
  return exe;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed: ${err.message}\n${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe("lldb-dap sample.cpp", { skip: probeReason() }, () => {
  it("hits the breakpoint and reads stack + locals", async () => {
    const adapterPath = testLldbDapPath();
    if (!adapterPath) throw new Error("lldb-dap is required for this test");
    const clang = clangPath();
    if (!clang) throw new Error("clang++ is required for this test");

    const dir = await mkdtemp(join(tmpdir(), "jb-dap-sample-"));
    const exe = join(dir, process.platform === "win32" ? "sample.exe" : "sample");
    try {
      const compileArgs =
        process.platform === "win32"
          ? ["-g", "-O0", "-gcodeview", "-o", exe, FIXTURE]
          : ["-g", "-O0", "-o", exe, FIXTURE];
      await run(clang, compileArgs);
      const line = breakLine(FIXTURE);
      const session = await DebugSession.launch({
        adapterPath,
        program: exe,
        cwd: dir,
        breakpoints: [{ path: FIXTURE, line }],
        stopTimeoutMs: 45_000,
      });
      try {
        assert.equal(session.stopped?.reason, "breakpoint");
        const stack = await session.stack();
        const names = stack.map((f) => f.name).join(" ");
        assert.match(names, /add/i);
        assert.match(names, /main/i);
        const locals = await session.locals();
        const byName = Object.fromEntries(
          locals.map((v) => [v.name.replace(/^&/, ""), v.value]),
        );
        const a = parseDbgInt(byName.a ?? byName.A);
        const b = parseDbgInt(byName.b ?? byName.B);
        assert.equal(a, 40, `locals=${JSON.stringify(locals)}`);
        assert.equal(b, 2, `locals=${JSON.stringify(locals)}`);
        const hover = await session.evaluateHover("a", stack[0]!.id);
        assert.equal(parseDbgInt(hover.result), 40);
      } finally {
        await session.dispose();
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      await rmQuiet(dir);
    }
  });
});

function parseDbgInt(raw: string | undefined): number {
  const token = (raw ?? "").trim().split(/\s+/)[0] ?? "";
  if (/^0x/i.test(token)) return Number.parseInt(token, 16);
  return Number.parseInt(token, 10);
}

function probeReason(): string | boolean {
  if (!testLldbDapPath()) return "lldb-dap not installed";
  if (!clangPath()) return "clang++ not installed";
  if (!existsSync(FIXTURE)) return "sample.cpp missing";
  return false;
}

async function rmQuiet(dir: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
