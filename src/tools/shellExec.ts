import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { excludedProjectShell } from "./shellExclusions.js";

/**
 * Shared shell process executor (no tool / policy coupling).
 *
 * Semantics extracted from the `run_shell` tool handler so the FSM
 * NodeAction path and the tool path share one implementation:
 * - `/bin/zsh -lc` on macOS, `/bin/bash -lc` (→ `/bin/sh -c`) on other
 *   POSIX systems, `cmd.exe /d /s /c` on Windows;
 * - detached process group (POSIX) so timeout / cancel kill background
 *   grandchildren too;
 * - timeout → SIGTERM the group, SIGKILL whatever survives the grace period;
 * - abort signal → same group termination, resolves as `cancelled`;
 * - settles on shell "exit" with a short output-flush window (a backgrounded
 *   grandchild can hold the pipes open indefinitely).
 */

/** Grace between SIGTERM and SIGKILL for a process group that ignores TERM. */
export const SHELL_KILL_GRACE_MS = 2_000;
/** Time given to drain the pipes once the shell itself has exited. */
export const SHELL_OUTPUT_FLUSH_MS = 200;

export type ShellExecStatus =
  | "done"
  | "timeout"
  | "cancelled"
  | "spawn-error";

export type ShellExecInput = {
  /** Internal lifetime/policy options. Ordinary Larry Agent sessions retain their behavior. */
  managed?: boolean;
  excludedPaths?: string[];
  /** Shell script body to execute. */
  command: string;
  /** Working directory for the shell process. */
  cwd: string;
  /**
   * Kill the process group after this many milliseconds.
   * `0` or a negative value disables the wall-clock timer (run until exit / cancel).
   */
  timeoutMs: number;
  /** Cooperative cancel; group-terminated on abort. */
  signal?: AbortSignal;
  /** Extra env vars merged over `process.env`. */
  env?: Record<string, string>;
  /**
   * Live output tap for streaming UIs (e.g. rsync upload progress).
   * Called per decoded chunk while the process runs, in addition to the
   * buffered stdout/stderr on the final result. Chunks are not line-aligned
   * (rsync progress uses \r); consumers do their own framing.
   */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
};

export type ShellExecResult = {
  status: ShellExecStatus;
  /** Shell exit code (null when killed before reporting one). */
  exitCode: number | null;
  /** Terminating signal name, when the process died by signal. */
  signalName: string | null;
  stdout: string;
  stderr: string;
  /** Spawn / setup failure message (status "spawn-error"). */
  errorMessage?: string;
};

/**
 * Signal the whole process group. Killing only the shell leaves background
 * grandchildren alive, and those keep the stdio pipes open forever.
 * Windows has no POSIX process groups — taskkill /T takes the tree down.
 */
function killTree(
  child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (typeof pid !== "number") return;
  if (process.platform === "win32") {
    // /T kills grandchildren too (cmd shells spawn them); /F is force — cmd
    // has no graceful SIGTERM, and a TERM'd cmd leaves grandchildren holding
    // the pipes. Fired async (non-blocking); the direct kill below drops the
    // shell itself immediately.
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // taskkill unavailable — the direct kill below still ends the shell.
    }
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Resolve the Windows shell to an absolute path once: spawning a bare
 * "cmd.exe" makes libuv walk PATH synchronously on the caller's thread
 * (Electron main process → whole-app IPC stalls); %ComSpec% is absolute.
 * Fallback stays "cmd.exe" for exotic setups where ComSpec is unset.
 */
function windowsShellPath(): string {
  return process.env.ComSpec || "cmd.exe";
}

/** POSIX shell candidate: path + argv prefix (`-l` only for login shells). */
export interface PosixShell {
  shell: string;
  args: string[];
}

/**
 * POSIX shell resolution. macOS stays byte-identical (`/bin/zsh -lc`,
 * always present on darwin). Other POSIX hosts — the linux-arm64 agentd on
 * Raspberry Pi OS — ship without zsh, and a hardcoded `/bin/zsh` made every
 * spawn die with ENOENT (spawn-error), so resolve bash first and fall back
 * to plain `sh` (dash has no usable `-l`).
 */
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

/** Resolved once per process — the filesystem does not change under us. */
let cachedPosixShell: PosixShell | null = null;

export function execShellProcess(input: ShellExecInput): Promise<ShellExecResult> {
  if (input.signal?.aborted) return Promise.resolve({ status: "cancelled", exitCode: null, signalName: null, stdout: "", stderr: "" });
  const posix = cachedPosixShell ?? resolvePosixShell();
  cachedPosixShell = posix;
  const shell = process.platform === "win32" ? windowsShellPath() : posix.shell;
  const shellArgs =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          // UTF-8 codepage for this cmd instance: git / node / python output
          // must reach the model as readable UTF-8, not OEM-codepage
          // mojibake (GBK on zh-CN Windows). ">nul" hides chcp's own line;
          // "&&" keeps the user command's exit code.
          //
          // Wrapped in quotes and paired with windowsVerbatimArguments below:
          // libuv's default argv quoting escapes inner `"` as `\"`, which cmd
          // does not understand, so every command carrying a quoted path
          // (any path with spaces) died with "The filename, directory name,
          // or volume label syntax is incorrect." `/s` strips exactly this
          // outer pair and takes the rest literally — the same `cmd /d /s /c
          // "…"` + verbatim idiom Node itself uses for `shell: true`.
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
      // detached: own process group, so timeout / cancel can kill background
      // grandchildren too (never unref'd — we still own the lifetime).
      const invocation = excludedProjectShell(shell, shellArgs, input.excludedPaths ?? []);
      child = spawn(invocation.command, invocation.args, {
        cwd: input.cwd,
        env: input.env ? { ...process.env, ...input.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        // GUI-subsystem parent: without this, every spawn of a console
        // program (cmd.exe / git.exe / …) allocates a fresh console — on
        // Win11 with Windows Terminal as default, each call launches a full
        // WindowsTerminal.exe (heavy, focus-stealing, window flash) and
        // blocks the main process while it does.
        ...(process.platform === "win32"
          ? { windowsHide: true, windowsVerbatimArguments: true }
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
      // Stop buffering and stop holding the event loop for a surviving
      // background child. Not destroyed: that would EPIPE a process the
      // user deliberately backgrounded.
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        stream.removeAllListeners("data");
        if (input.managed) stream.destroy();
        // Pipes are Sockets at runtime; Readable does not declare unref.
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
      // Await group cleanup even when the shell has already returned. Coco
      // commands must not leave ordinary background children behind on quit.
      killTimer = setTimeout(() => { killTree(child, "SIGKILL"); settle(result); }, 250);
    };

    /** SIGTERM the group, then SIGKILL whatever survives the grace period. */
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
        // A misbehaving live consumer must not kill the process pipeline.
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      try {
        input.onOutput?.(chunk, "stderr");
      } catch {
        // Same guard for stderr consumers.
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

    // Settle on "exit" (the shell is done) rather than "close": a backgrounded
    // grandchild can hold the pipes open indefinitely, and waiting for them
    // would hang the executor past its own timeout. "close" only shortcuts
    // the flush wait when the pipes do drain.
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
