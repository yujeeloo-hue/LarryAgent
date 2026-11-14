/**
 * devmode:runExecutable — launch a tree executable the way the OS shell
 * would on double-click. Pure planning (platform rules, ext whitelist, exec
 * bit) lives in devModeFs.ts so it stays testable under plain node; this
 * module only owns the electron / child_process side effects.
 */
import { shell } from "electron";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { planExecutableLaunch } from "./devModeFs.js";

export type RunExecutableResult =
  | { ok: true }
  | { ok: false; message: string };

export async function runDevModeExecutable(
  targetPath: unknown,
): Promise<RunExecutableResult> {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  const path = resolve(targetPath.trim());
  let info;
  try {
    info = await stat(path);
  } catch {
    return { ok: false, message: "File not found" };
  }
  if (!info.isFile()) return { ok: false, message: "Not a regular file" };

  // Re-validate at launch time — the tree flag may be stale after a rebuild.
  const plan = planExecutableLaunch({
    platform: process.platform,
    ext: extname(path).slice(1),
    executableBit: (info.mode & 0o111) !== 0,
  });
  if (plan.kind === "reject") return { ok: false, message: plan.reason };

  if (plan.kind === "open-path") {
    // Explorer / Finder double-click semantics (win: .exe/.bat/… get their
    // console window; mac: .command runs inside Terminal).
    const err = await shell.openPath(path);
    return err ? { ok: false, message: err } : { ok: true };
  }

  // Detached spawn: fully independent of this app (survives quit), cwd at
  // the binary's directory so relative assets resolve; output is discarded —
  // same as Finder launching a non-Terminal binary.
  return await new Promise<RunExecutableResult>((done) => {
    let child;
    try {
      child = spawn(path, [], {
        detached: true,
        stdio: "ignore",
        cwd: dirname(path),
      });
    } catch (err) {
      done({ ok: false, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    let settled = false;
    const finish = (result: RunExecutableResult): void => {
      if (settled) return;
      settled = true;
      done(result);
    };
    // spawn reports async failures (ENOENT / EACCES / bad Mach-O) here.
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ ok: false, message: err.message });
    });
    child.unref();
    // One macrotask is enough to observe the error channel without waiting
    // on the (unref'd) child.
    setTimeout(() => finish({ ok: true }), 50);
  });
}
