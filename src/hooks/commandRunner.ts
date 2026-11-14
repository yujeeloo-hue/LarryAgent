import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  applyDenyFailure,
  parseHookDecision,
} from "./merge.js";
import type { HookDecision, MergedHookResult } from "./types.js";

const DEFAULT_TIMEOUT_SEC = 10;

/** Quote a path for `/bin/sh -c` so spaces (e.g. Application Support) stay intact. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type RunCommandHookInput = {
  command: string;
  /** Working directory (workspace root). */
  cwd: string;
  payload: unknown;
  timeoutSec?: number;
  failClosed?: boolean;
  signal?: AbortSignal;
};

export type RunCommandHookResult =
  | { ok: true; decision: HookDecision }
  | { ok: false; denied: boolean; message: string };

/**
 * Resolve a relative command path against cwd; absolute paths stay as-is.
 * Commands with spaces / shell features are run via `/bin/sh -c`, so resolved
 * executable paths are single-quoted when needed.
 */
export function resolveCommandPath(command: string, cwd: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;

  // Entire command is an existing absolute path (may contain spaces).
  if (isAbsolute(trimmed) && existsSync(trimmed)) {
    return shellSingleQuote(trimmed);
  }

  // Simple relative script path (no shell metacharacters in first token)
  const first = trimmed.split(/\s+/)[0] ?? trimmed;
  if (
    !isAbsolute(first) &&
    (first.startsWith("./") ||
      first.startsWith("../") ||
      first.startsWith(".jellybot/"))
  ) {
    const rest = trimmed.slice(first.length).trimStart();
    const abs = resolve(cwd, first);
    const quoted = shellSingleQuote(abs);
    return rest ? `${quoted} ${rest}` : quoted;
  }

  // Absolute executable + args (path itself has no spaces).
  if (isAbsolute(first) && existsSync(first)) {
    const rest = trimmed.slice(first.length).trimStart();
    const quoted = shellSingleQuote(first);
    return rest ? `${quoted} ${rest}` : quoted;
  }

  return trimmed;
}

export async function runCommandHook(
  input: RunCommandHookInput,
): Promise<RunCommandHookResult> {
  const timeoutSec =
    typeof input.timeoutSec === "number" && input.timeoutSec > 0
      ? input.timeoutSec
      : DEFAULT_TIMEOUT_SEC;
  const failClosed = input.failClosed === true;
  const commandLine = resolveCommandPath(input.command, input.cwd);

  if (!commandLine) {
    const message = "Hook command is empty";
    return failClosed
      ? { ok: false, denied: true, message }
      : { ok: false, denied: false, message };
  }

  const stdinJson = `${JSON.stringify(input.payload)}\n`;

  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result: RunCommandHookResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const child = spawn("/bin/sh", ["-c", commandLine], {
      cwd: input.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const message = `Hook timed out after ${timeoutSec}s`;
      settle(
        failClosed
          ? { ok: false, denied: true, message }
          : { ok: false, denied: false, message },
      );
    }, timeoutSec * 1000);

    const onAbort = () => {
      child.kill("SIGTERM");
      clearTimeout(timer);
      settle({ ok: false, denied: false, message: "Hook aborted" });
    };
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      const message = err.message || "Hook spawn failed";
      settle(
        failClosed
          ? { ok: false, denied: true, message }
          : { ok: false, denied: false, message },
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);

      // Exit 2 = explicit deny (Cursor-compatible)
      if (code === 2) {
        settle({
          ok: false,
          denied: true,
          message: stderr.trim() || "Hook denied (exit 2)",
        });
        return;
      }

      if (code !== 0 && code !== null) {
        const message =
          stderr.trim() || `Hook exited with code ${code}`;
        settle(
          failClosed
            ? { ok: false, denied: true, message }
            : { ok: false, denied: false, message },
        );
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        settle({ ok: true, decision: {} });
        return;
      }

      try {
        const parsed: unknown = JSON.parse(trimmed);
        settle({ ok: true, decision: parseHookDecision(parsed) });
      } catch {
        // Some hooks print trailing logs; try last JSON object line
        const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
        const last = lines[lines.length - 1] ?? "";
        try {
          const parsed: unknown = JSON.parse(last);
          settle({ ok: true, decision: parseHookDecision(parsed) });
        } catch {
          const message = "Hook returned invalid JSON";
          settle(
            failClosed
              ? { ok: false, denied: true, message }
              : { ok: false, denied: false, message },
          );
        }
      }
    });

    try {
      child.stdin?.write(stdinJson);
      child.stdin?.end();
    } catch {
      // ignore broken pipe; close handler will settle
    }
  });
}

/** Apply a failed command result onto the merge accumulator. */
export function applyCommandFailure(
  acc: MergedHookResult,
  result: Extract<RunCommandHookResult, { ok: false }>,
): MergedHookResult {
  if (result.denied) {
    return applyDenyFailure(acc, result.message);
  }
  return acc;
}
