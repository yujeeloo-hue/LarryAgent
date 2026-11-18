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

  const plan = planExecutableLaunch({
    platform: process.platform,
    ext: extname(path).slice(1),
    executableBit: (info.mode & 0o111) !== 0,
  });
  if (plan.kind === "reject") return { ok: false, message: plan.reason };

  if (plan.kind === "open-path") {
    const err = await shell.openPath(path);
    return err ? { ok: false, message: err } : { ok: true };
  }

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
    child.once("error", (err: NodeJS.ErrnoException) => {
      finish({ ok: false, message: err.message });
    });
    child.once("spawn", () => finish({ ok: true }));
    child.unref();
  });
}
