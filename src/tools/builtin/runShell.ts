import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  JsonObject,
  ToolDefinition,
  ToolHandler,
  ToolRiskAssessment,
  ToolRiskAssessor,
  ToolRiskRewrite,
} from "../types.js";
import {
  abortIfSignaled,
  cancelledResult,
  failureResult,
  textResult,
  workspaceRootAbsolute,
} from "../pathUtil.js";
import { analyzeShellCommand } from "../policy/shellSafety.js";
import { worstFinding } from "../policy/shellDangerRules.js";
import { getShellSafetyConfig } from "../policy/shellSafetyConfig.js";
import { execShellProcess } from "../shellExec.js";
import { IS_WINDOWS } from "../../platformCaps.js";
import { SHELL_TOOL_NAME } from "../shellToolName.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;

/** Default level: 1 (full-permissions gate). */
export const runShellDefinition: ToolDefinition = {
  // Windows v1: registers as exec_command with a cmd.exe-aware description;
  // macOS stays byte-identical (run_shell, original text).
  name: SHELL_TOOL_NAME,
  description: IS_WINDOWS
    ? "Run a command in the workspace root using cmd.exe. " +
      "Do NOT use this for scp uploads to a remote host — call upload_files instead."
    : "Run a shell command starting in the workspace root. " +
      "Do NOT use this for rsync/scp uploads to a remote host — call upload_files instead.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute." },
    },
    required: ["command"],
  },
  defaultPermissionLevel: 1,
  assessRisk: runShellRiskAssessor,
};

/**
 * Soft redirect: rsync-to-remote uploads belong to the dedicated
 * upload_files tool (live progress card, structured args, .env guard).
 * Failing fast with a pointer beats silently running an un-enhanced
 * rsync the model thinks it can stream progress for.
 */
const REMOTE_UPLOAD_RE = /\brsync\b[\s\S]*?[\w@][\w.-]*:[\/]\S*/;
export function isRemoteRsyncUpload(command: string): boolean {
  return REMOTE_UPLOAD_RE.test(command);
}

/**
 * Shell Safe Mode assessor v2 (plan: docs/plans/20260819-rm-shell-safe-mode-v2.md).
 * normal → allow (rm carries its Trash rewrite); confirm → confirm card in
 * Safe Mode, allow under Bypass (rewrite attached either way so approval
 * executes the recoverable variant); fatal → confirm card in both modes or
 * hard block when fatalPolicy = "block" (settled). rmUnrewritable (rm that
 * can never be safely Trash-routed) blocks outright — no approval path ever
 * performs a hard delete.
 */
function assessRunShellRisk(input: {
  arguments: JsonObject;
  fullPermissionsEnabled: boolean;
  reviewHighRisk?: boolean;
  workspacePath?: string;
}): ToolRiskAssessment {
  const command = typeof input.arguments.command === "string" ? input.arguments.command : null;
  if (command === null || command.trim().length === 0) {
    return { action: "defer" }; // invalid args — handler rejects with details
  }
  const workspacePath =
    input.workspacePath && input.workspacePath.trim().length > 0
      ? input.workspacePath
      : process.cwd();
  const analysis = analyzeShellCommand(command, { workspacePath });

  const rewrite: ToolRiskRewrite | undefined = analysis.rewrite
    ? {
        type: "trash",
        targets: analysis.rewrite.targets,
        force: analysis.rewrite.force,
        originalCommand: analysis.rewrite.originalCommand,
      }
    : undefined;

  // rm that can never be safely Trash-routed: hard block regardless of
  // mode or policy — approval must never become a hard delete.
  if (analysis.rmUnrewritable) {
    const f =
      analysis.findings.find(
        (x) => x.ruleId === "rm-unrewritable" || x.ruleId === "rm-unresolvable-target",
      ) ?? analysis.findings[0];
    return {
      action: "block",
      reason: f?.reason ?? "rm cannot be safely routed to the Trash.",
      ...(f?.hint ? { hint: f.hint } : {}),
    };
  }

  if (analysis.riskClass === "normal") {
    return rewrite ? { action: "allow", rewrite } : { action: "allow" };
  }

  const finding = worstFinding(analysis.findings);
  if (!finding) return { action: "allow" };

  if (finding.severity === "fatal") {
    if (getShellSafetyConfig().fatalPolicy === "block") {
      return { action: "block", reason: finding.reason, ...(finding.hint ? { hint: finding.hint } : {}) };
    }
    return {
      action: "confirm",
      fatal: true,
      reason: finding.reason,
      ...(finding.hint ? { hint: finding.hint } : {}),
      ...(rewrite ? { rewrite } : {}),
    };
  }

  // Class B: allowed without asking once Bypass is on (settled), except on
  // supervised turns where the supervisor reviews every high-risk command.
  if (input.fullPermissionsEnabled && input.reviewHighRisk !== true) {
    return rewrite ? { action: "allow", rewrite } : { action: "allow" };
  }
  return {
    action: "confirm",
    fatal: false,
    reason: finding.reason,
    ...(finding.hint ? { hint: finding.hint } : {}),
    ...(rewrite ? { rewrite } : {}),
  };
}

export function runShellRiskAssessor(input: {
  arguments: JsonObject;
  fullPermissionsEnabled: boolean;
  reviewHighRisk?: boolean;
  workspacePath?: string;
}): ToolRiskAssessment {
  return assessRunShellRisk(input);
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`;
}


export const runShellHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const command = typeof args.command === "string" ? args.command : null;
  if (command === null || command.trim().length === 0) {
    return failureResult(
      'Invalid arguments: "command" (string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  // rsync-to-remote uploads go through upload_files (live progress card,
  // structured args, .env guard) — redirect instead of running bare.
  if (isRemoteRsyncUpload(command)) {
    return failureResult(
      'rsync uploads to a remote host must use the upload_files tool ' +
        '(args: src, dest_host, dest_path, optional delete/dry_run/excludes). ' +
        "Re-issue the call as upload_files.",
      ToolReturnCode.InvalidArguments,
    );
  }

  const cwd = workspaceRootAbsolute(context.workspacePath);

  // rsync uploads go through the dedicated upload_files tool now — the
  // command detection route was removed (see builtin/uploadFiles.ts).
  const result = await (context.cocoShell ?? execShellProcess)({
    command,
    cwd,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });

  if (result.status === "cancelled") {
    return cancelledResult();
  }
  if (result.status === "timeout") {
    const timedOut = failureResult(
      truncate(
        `Command timed out after ${DEFAULT_TIMEOUT_MS}ms\n${result.stderr || result.stdout}`,
      ),
      ToolReturnCode.Timeout,
    );
    return context.shellStructuredReceipt
      ? { ...timedOut, receipt: shellReceipt(null, result.stdout, result.stderr, true) }
      : timedOut;
  }
  if (result.status === "spawn-error") {
    return failureResult(
      result.errorMessage ?? "Failed to spawn shell",
      ToolReturnCode.GenericFailure,
    );
  }

  const signalName = result.signalName;
  const exit = result.exitCode ?? (signalName ? 1 : 0);
  const parts = [
    `$ ${command}`,
    `cwd ${cwd}`,
    `exit ${exit}${signalName ? ` signal=${signalName}` : ""}`,
  ];
  const stdoutText = result.stdout;
  if (stdoutText) parts.push("--- stdout ---", truncate(stdoutText));
  if (result.stderr) parts.push("--- stderr ---", truncate(result.stderr));
  const body = parts.join("\n");

  const out = textResult(
    body,
    exit === 0 ? ToolReturnCode.Success : ToolReturnCode.GenericFailure,
  );
  return context.shellStructuredReceipt
    ? { ...out, receipt: shellReceipt(exit, result.stdout, result.stderr, false, signalName) }
    : out;
};

const RECEIPT_TEXT_CHARS = 4_000;

/** Structured facts for FSM guards (model-invisible; see ToolExecuteResult.receipt). */
function shellReceipt(
  exitCode: number | null,
  stdout: string | undefined,
  stderr: string | undefined,
  timedOut: boolean,
  signal?: string | null,
): JsonObject {
  return {
    exitCode,
    timedOut,
    signal: signal ?? null,
    stdout: (stdout ?? "").slice(0, RECEIPT_TEXT_CHARS),
    stderr: (stderr ?? "").slice(0, RECEIPT_TEXT_CHARS),
  };
}

