import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { FsmRunShellInput, FsmRunShellResult } from "../agent/types.js";
import { workspaceRootAbsolute } from "./pathUtil.js";
import { execShellProcess } from "./shellExec.js";

export const FSM_SHELL_DEFAULT_TIMEOUT_MS = 60_000;
export const FSM_SHELL_MIN_TIMEOUT_MS = 1_000;

function clampTimeout(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return FSM_SHELL_DEFAULT_TIMEOUT_MS;
  }
  return Math.max(FSM_SHELL_MIN_TIMEOUT_MS, Math.round(raw));
}

export async function runFsmShellScript(
  input: FsmRunShellInput,
  workspacePath: string,
): Promise<FsmRunShellResult> {
  const workspaceRoot = workspaceRootAbsolute(workspacePath);
  const cwdSpec = input.cwd?.trim() ?? "";
  const cwd = cwdSpec
    ? isAbsolute(cwdSpec)
      ? cwdSpec
      : resolve(workspaceRoot, cwdSpec)
    : workspaceRoot;

  const errorOut = (
    errorMessage: string,
    extra?: Partial<FsmRunShellResult>,
  ): FsmRunShellResult => ({
    status: "error",
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: false,
    command: "",
    cwd,
    ...extra,
    errorMessage,
  });

  const inline = input.command?.trim() ? input.command : undefined;
  const scriptPath = input.scriptPath?.trim() ? input.scriptPath.trim() : undefined;

  let command: string;
  if (inline) {
    command = inline;
  } else if (scriptPath) {
    const absolute = isAbsolute(scriptPath)
      ? scriptPath
      : resolve(workspaceRoot, scriptPath);
    try {
      command = await readFile(absolute, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorOut(`Cannot read shell script "${absolute}": ${message}`);
    }
    if (!command.trim()) {
      return errorOut(`Shell script "${absolute}" is empty.`);
    }
  } else {
    return errorOut("Provide either command (inline script) or scriptPath.");
  }

  const exec = await execShellProcess({
    command,
    cwd,
    timeoutMs: clampTimeout(input.timeoutMs),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.env && Object.keys(input.env).length > 0
      ? { env: input.env }
      : {}),
  });

  if (exec.status === "cancelled") {
    return {
      status: "error",
      exitCode: null,
      stdout: exec.stdout,
      stderr: exec.stderr,
      timedOut: false,
      cancelled: true,
      command,
      cwd,
      errorMessage: "Shell execution cancelled.",
    };
  }
  if (exec.status === "timeout") {
    return {
      status: "error",
      exitCode: null,
      stdout: exec.stdout,
      stderr: exec.stderr,
      timedOut: true,
      cancelled: false,
      command,
      cwd,
      errorMessage: `Shell script timed out after ${clampTimeout(input.timeoutMs)}ms.`,
    };
  }
  if (exec.status === "spawn-error") {
    return {
      status: "error",
      exitCode: null,
      stdout: exec.stdout,
      stderr: exec.stderr,
      timedOut: false,
      cancelled: false,
      command,
      cwd,
      errorMessage: exec.errorMessage ?? "Failed to spawn shell.",
    };
  }

  const ok = exec.exitCode === 0;
  return {
    status: ok ? "ok" : "error",
    exitCode: exec.exitCode,
    stdout: exec.stdout,
    stderr: exec.stderr,
    timedOut: false,
    cancelled: false,
    command,
    cwd,
    ...(!ok && exec.stderr.trim() === ""
      ? { errorMessage: `Shell script exited with code ${exec.exitCode ?? "null"}.` }
      : {}),
  };
}
