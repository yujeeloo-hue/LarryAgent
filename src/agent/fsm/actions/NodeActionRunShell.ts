import type { FsmParamsSchema } from "../paramsSchema.js";
import { FSMConfigError } from "../FSMConfigError.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import {
  numberParam,
  NodeActionStubBase,
  stringParam,
} from "./NodeActionStubBase.js";

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

/** nodeContext strings are capped so turn context stays small. */
const MAX_CONTEXT_OUTPUT_CHARS = 10_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_CONTEXT_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_OUTPUT_CHARS)}\n…(truncated)`;
}

export function validateNodeActionRunShellParams(
  params: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const command = typeof params.command === "string" ? params.command.trim() : "";
  const scriptPath = typeof params.scriptPath === "string" ? params.scriptPath.trim() : "";
  if (!command && !scriptPath) {
    throw new FSMConfigError(
      "INVALID_ACTION_PARAMS",
      `${label}: requires either "command" or "scriptPath"`,
    );
  }
  if (command && scriptPath) {
    throw new FSMConfigError(
      "INVALID_ACTION_PARAMS",
      `${label}: accepts only one of "command" / "scriptPath"`,
    );
  }
}

export const NodeActionRunShellSchema: FsmParamsSchema = {
  type: "object",
  title: "Run shell",
  description:
    "Execute a shell script when this node runs — inline command or a .sh file. Exit code / stdout / stderr land in nodeContext (shellExitCode / shellStdout / shellStderr) for EdgeWhen (source: node) routing. Ungated: graph config is user-authored and trusted.",
  "x-llmDescription": "Run a shell script when the node runs: command (inline body, /bin/zsh -lc in the workspace) or scriptPath — exactly one. cwd, timeoutMs (default 60000, kills the process group), onError halt (default) | continue. Results land in nodeContext shellExitCode / shellStdout / shellStderr — branch with EdgeWhen source 'node'.",
  details: `Executes a shell script when the node runs: exactly one of command (inline body, run under /bin/zsh -lc in the workspace) or scriptPath (absolute or workspace-relative) — enforced by the registered validator at graph validate time and re-checked at Exec. The run goes through the Host runShell capability (main-process only) with an optional cwd override; timeoutMs (default 60000) kills the script's whole process group.

Results land in nodeContext: shellRan, shellExitCode, shellStdout, shellStderr (both capped at 10000 chars), shellTimedOut, shellCancelled, shellCwd. Branch on them with EdgeWhen source:'node' (e.g. turnKey shellExitCode equals 0). onError halt (default) stops the turn on failure; continue keeps routing. No Host (stub/sample graphs): no-op skip.`,
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      title: "Command",
      description:
        "Inline shell script body (runs under /bin/zsh -lc in the workspace). Required unless Script path is set.",
      "x-ui": "textarea",
    },
    scriptPath: {
      type: "string",
      title: "Script path",
      description:
        "Shell script file to run — absolute, or relative to the workspace root. Required unless Command is set.",
      "x-ui": "text",
    },
    cwd: {
      type: "string",
      title: "Working directory",
      description:
        "Working directory for the script. Defaults to the workspace root; relative paths resolve against it.",
      "x-ui": "text",
    },
    timeoutMs: {
      type: "integer",
      default: DEFAULT_SHELL_TIMEOUT_MS,
      minimum: 1_000,
      title: "Timeout (milliseconds)",
      description:
        "Kill the script's whole process group after this many milliseconds. Default 60000 = 1 minute.",
      "x-ui": "number",
    },
    onError: {
      type: "string",
      enum: ["halt", "continue"],
      default: "halt",
      title: "On error",
      description:
        "halt: stop the turn on failure (non-zero exit, timeout, unreadable script). continue: keep routing — branch on shellExitCode with EdgeWhen instead.",
      "x-ui": "select",
      "x-enumLabels": {
        halt: "Halt turn",
        continue: "Continue graph",
      },
    },
  },
};

/**
 * Execute an arbitrary shell script as a node action (graph extensibility).
 *
 * Exactly one of `command` (inline body) / `scriptPath` (.sh file) — enforced
 * at graph-validate time by its registered validator. The run
 * goes through the Host `runShell` capability (sessionRuntime-injected,
 * main-process only); without a Host the action is a no-op skip so sample
 * graphs stay runnable.
 *
 * Results land in **nodeContext** (round-scoped, fresh per node visit):
 * `shellRan`, `shellExitCode`, `shellStdout`, `shellStderr` (both truncated),
 * `shellTimedOut`, `shellCancelled`, `shellCwd`. Route on them with
 * EdgeWhen `source: "node"` (e.g. turnKey `shellExitCode`, equals 0).
 */
export class NodeActionRunShell extends NodeActionStubBase {
  readonly type = "NodeActionRunShell";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const host = args.host;
    if (!host?.runShell) {
      return {
        status: "continue",
        nodeContextPatch: { shellSkipped: true },
      };
    }

    const rawCommand = stringParam(this.params, "command");
    const command = rawCommand?.trim() ? rawCommand : undefined;
    const rawScriptPath = stringParam(this.params, "scriptPath");
    const scriptPath = rawScriptPath?.trim() ? rawScriptPath!.trim() : undefined;
    if (!command && !scriptPath) {
      // Factory validates this at graph-load time; defensive Exec-time net.
      return {
        status: "halt",
        errorMessage:
          'NodeActionRunShell requires either "command" or "scriptPath".',
      };
    }

    const cwd = stringParam(this.params, "cwd")?.trim() || undefined;
    const timeoutMs = numberParam(
      this.params,
      "timeoutMs",
      DEFAULT_SHELL_TIMEOUT_MS,
    );
    const haltOnError = stringParam(this.params, "onError", "halt") !== "continue";

    const label = scriptPath ?? (command ?? "").split("\n")[0]!.slice(0, 80);
    host.emitProgress(`Run shell: ${label}${scriptPath ? "" : " …"}`);

    const result = await host.runShell({
      ...(command ? { command } : {}),
      ...(scriptPath ? { scriptPath } : {}),
      ...(cwd ? { cwd } : {}),
      timeoutMs,
      ...(host.signal ? { signal: host.signal } : {}),
    });

    const nodeContextPatch = {
      shellRan: true,
      shellExitCode: result.exitCode,
      shellStdout: truncateOutput(result.stdout),
      shellStderr: truncateOutput(result.stderr),
      shellTimedOut: result.timedOut,
      shellCancelled: result.cancelled,
      shellCwd: result.cwd,
    };

    if (result.cancelled) {
      return {
        status: "halt",
        errorMessage: "Run shell cancelled.",
        nodeContextPatch,
      };
    }

    if (result.status === "error") {
      const detail =
        [result.errorMessage, result.stderr.trim()]
          .filter((part) => part && part.length > 0)
          .join("\n") || `exit ${String(result.exitCode)}`;
      if (haltOnError) {
        return {
          status: "halt",
          errorMessage: `Run shell failed: ${detail}`,
          nodeContextPatch,
        };
      }
      // No terminal progress word: the shell result is on its own card /
      // nodeContext, and the next node's progress owns the status line.
      return { status: "continue", nodeContextPatch };
    }

    return { status: "continue", nodeContextPatch };
  }
}
