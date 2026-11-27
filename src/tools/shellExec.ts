import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { excludedProjectShell, SHELL_EXCLUSION_UNAVAILABLE, shellExclusionsEnforceable } from "./shellExclusions.js";


export const SHELL_KILL_GRACE_MS = 2_000;
export const SHELL_OUTPUT_FLUSH_MS = 200;

export type ShellExecStatus =
  | "done"
  | "timeout"
  | "cancelled"
  | "spawn-error";

export type ShellExecInput = {
  managed?: boolean;
  excludedPaths?: string[];
  /** Fail instead of running unscoped when the platform has no exclusion backend. */
  strictShellExclusions?: boolean;
  command: string;
  executable?: { file: string; args: string[] };
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
};

export type ShellExecResult = {
  status: ShellExecStatus;
  exitCode: number | null;
  signalName: string | null;
  stdout: string;
  stderr: string;
  errorMessage?: string;
};

export function killTree(
  child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (typeof pid !== "number") return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
    }
    try {
      child.kill(signal);
    } catch {
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
    }
  }
}

function windowsShellPath(): string {
  return process.env.ComSpec || "cmd.exe";
}

export interface PosixShell {
  shell: string;
  args: string[];
}

export function resolvePosixShell(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): PosixShell {
  if (platform === "darwin") return { shell: "/bin/zsh", args: ["-lc"] };
  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
    if (exists(candidate)) return { shell: candidate, args: ["-lc"] };
  }
  for (const candidate of ["/bin/sh", "/usr/bin/sh"]) {
    if (exists(candidate)) return { shell: candidate, args: ["-c"] };
  }
  return { shell: "/bin/sh", args: ["-c"] };
}

let cachedPosixShell: PosixShell | null = null;

export function execShellProcess(input: ShellExecInput): Promise<ShellExecResult> {
  if (input.signal?.aborted) return Promise.resolve({ status: "cancelled", exitCode: null, signalName: null, stdout: "", stderr: "" });
  if (input.strictShellExclusions && (input.excludedPaths?.length ?? 0) > 0 && !shellExclusionsEnforceable()) {
    return Promise.resolve({ status: "spawn-error", exitCode: null, signalName: null, stdout: "", stderr: "", errorMessage: SHELL_EXCLUSION_UNAVAILABLE });
  }
  const posix = cachedPosixShell ?? resolvePosixShell();
  cachedPosixShell = posix;
  const shell = process.platform === "win32" ? windowsShellPath() : posix.shell;
  const shellArgs =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          `"chcp 65001 >nul && ${input.command}"`,
        ]
      : ["-lc", input.command];

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    let child;
    try {
      const invocation = input.executable
        ? { command: input.executable.file, args: input.executable.args }
        : excludedProjectShell(shell, shellArgs, input.excludedPaths ?? []);
      child = spawn(invocation.command, invocation.args, {
        cwd: input.cwd,
        env: input.env ? { ...process.env, ...input.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        ...(process.platform === "win32"
          ? { windowsHide: true, windowsVerbatimArguments: !input.executable }
          : {}),
      });
    } catch (err) {
      resolve({
        status: "spawn-error",
        exitCode: null,
        signalName: null,
        stdout: "",
        stderr: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let killTimer: NodeJS.Timeout | undefined;
    let flushTimer: NodeJS.Timeout | undefined;

    let finishing = false;
    const settle = (result: ShellExecResult) => {
      if (settled) return;
      settled = true;
      if (input.managed) clearTimeout(killTimer);
      clearTimeout(timer);
      clearTimeout(flushTimer);
      input.signal?.removeEventListener("abort", onAbort);
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        stream.removeAllListeners("data");
        if (input.managed) stream.destroy();
        (stream as unknown as { unref?: () => void }).unref?.();
      }
      child.unref();
      resolve(result);
    };

    const finish = (result: ShellExecResult) => {
      if (settled || finishing) return;
      if (!input.managed) { settle(result); return; }
      finishing = true;
      clearTimeout(killTimer); clearTimeout(timer); clearTimeout(flushTimer);
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => { killTree(child, "SIGKILL"); settle(result); }, 250);
    };

    const terminate = () => {
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), SHELL_KILL_GRACE_MS);
    };

    const onAbort = () => {
      if (settled || finishing) return;
      timedOut = false;
      clearTimeout(killTimer);
      terminate();
      finish({
        status: "cancelled",
        exitCode: null,
        signalName: null,
        stdout,
        stderr,
      });
    };

    const timer =
      input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, input.timeoutMs)
        : undefined;

    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      try {
        input.onOutput?.(chunk, "stdout");
      } catch {
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      try {
        input.onOutput?.(chunk, "stderr");
      } catch {
      }
    });

    child.on("error", (err) => {
      finish({
        status: "spawn-error",
        exitCode: null,
        signalName: null,
        stdout,
        stderr,
        errorMessage: err.message,
      });
    });

    const settleFromExit = (
      code: number | null,
      signalName: NodeJS.Signals | null,
    ) => {
      if (settled || finishing) return;
      clearTimeout(killTimer);
      if (timedOut) {
        finish({
          status: "timeout",
          exitCode: null,
          signalName,
          stdout,
          stderr,
        });
        return;
      }
      if (input.signal?.aborted) {
        finish({
          status: "cancelled",
          exitCode: null,
          signalName,
          stdout,
          stderr,
        });
        return;
      }

      finish({
        status: "done",
        exitCode: code,
        signalName,
        stdout,
        stderr,
      });
    };

    child.on("exit", (code, signalName) => {
      flushTimer = setTimeout(
        () => settleFromExit(code, signalName),
        SHELL_OUTPUT_FLUSH_MS,
      );
    });

    child.on("close", (code, signalName) => {
      clearTimeout(flushTimer);
      settleFromExit(code, signalName);
    });
  });
}
