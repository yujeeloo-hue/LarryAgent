import { existsSync } from "node:fs";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  cancelledResult,
  failureResult,
  textResult,
  workspaceRootAbsolute,
} from "../pathUtil.js";
import { execShellProcess } from "../shellExec.js";
import { IS_WINDOWS } from "../../platformCaps.js";
import { collapseProgressLines } from "../uploadDetect.js";
import {
  buildRemoteSizeProbe,
  buildRsyncCommand,
  buildScpCommand,
  chooseUploadBackend,
  localUploadBytes,
  parseDestSpec,
  planUploadFiles,
  probeRemoteBytes,
  probeRsyncPrograms,
  scpProgressSample,
  UploadLiveTracker,
  UPLOAD_TIMEOUT_MS,
  type RsyncUploadPlan,
  type UploadEnhanceMode,
} from "../uploadExec.js";
import { prepareRsyncRuntime, rsyncProgramCandidates } from "../bundledRsync.js";

const MAX_OUTPUT_CHARS = 200_000;
/** Fallback progress poll — scp prints nothing when stdout is not a tty. */
const SCP_POLL_INTERVAL_MS = 800;
const SCP_EMIT_FLOOR_MS = 500;

/**
 * Dedicated rsync-over-SSH upload tool (supersedes the run_shell auto-detect
 * route): structured parameters instead of free-form command recognition,
 * so every invocation is enhanceable for the live progress card.
 *
 * Same permission level as run_shell — it writes to a remote host.
 */
export const uploadFilesDefinition: ToolDefinition = {
  name: "upload_files",
  description: IS_WINDOWS
    ? "Upload a local file or directory to a remote host via rsync over SSH, with live per-file progress in the UI. " +
      "Use this instead of exec_command for scp uploads (e.g. deploying a build to a server). " +
      "The host must already be reachable via SSH keys (no interactive password prompt)."
    : "Upload a local file or directory to a remote host via rsync over SSH, with live per-file progress in the UI. " +
      "Use this instead of run_shell for rsync/scp uploads (e.g. deploying a build to a server). " +
      "The host must already be reachable via SSH keys (no interactive password prompt).",
  parameters: {
    type: "object",
    properties: {
      src: {
        type: "string",
        description:
          "Local source path (file or directory). Workspace-relative paths resolve against the workspace root. Trailing-slash semantics follow rsync.",
      },
      dest_host: {
        type: "string",
        description: "Remote host: an SSH alias (from ~/.ssh/config) or user@host.",
      },
      dest_path: {
        type: "string",
        description: "Absolute destination path on the remote host (must start with /).",
      },
      delete: {
        type: "boolean",
        description:
          "Also delete remote files that are absent from src (--delete). Exclude .env or other secrets when using this. Default false.",
      },
      dry_run: {
        type: "boolean",
        description: "Trial run that changes nothing (-n). Default false.",
      },
      excludes: {
        type: "array",
        items: { type: "string" },
        description:
          'rsync --exclude patterns, e.g. [".env", "node_modules"].',
      },
    },
    required: ["src", "dest_host", "dest_path"],
  },
  defaultPermissionLevel: 1,
};

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`;
}

type UploadContext = Parameters<ToolHandler>[1];

type UploadRun = {
  command: string;
  backend: "rsync" | "scp";
  result: Awaited<ReturnType<typeof execShellProcess>>;
};

/** rsync path: live progress parsed from rsync's own counter output. */
async function runRsyncUpload(
  plan: RsyncUploadPlan,
  mode: UploadEnhanceMode,
  cwd: string,
  context: UploadContext,
  program = "rsync",
): Promise<UploadRun> {
  // Probe the local rsync flavor once; openrsync (stock macOS) needs the
  // legacy --progress enhancement instead of --info=progress2.
  const command = buildRsyncCommand(plan, mode, process.platform, program);
  const runtime = prepareRsyncRuntime(program);
  const tracker =
    context.emitLive !== undefined
      ? new UploadLiveTracker(plan, mode, (payload) => context.emitLive!("upload", payload))
      : null;

  try {
    const result = await execShellProcess({
      command,
      cwd,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      ...(runtime.env ? { env: runtime.env } : {}),
      ...(tracker ? { onOutput: (chunk) => tracker.onChunk(chunk) } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (tracker && tracker.streamed) tracker.flush();
    return { command, backend: "rsync", result };
  } finally {
    runtime.cleanup();
  }
}

/**
 * Windows fallback: scp (ships with OpenSSH, no rsync required). scp writes
 * no progress when stdout is not a tty, so the card is fed by polling the
 * destination's on-disk size over SSH — bytes that have actually landed,
 * not bytes the protocol queued.
 */
async function runScpUpload(
  plan: RsyncUploadPlan,
  cwd: string,
  context: UploadContext,
): Promise<UploadRun> {
  const command = buildScpCommand(plan);
  const dest = parseDestSpec(plan.destSpec);
  const local = await localUploadBytes(plan.srcPath);
  const startedAt = Date.now();

  const emit = (remoteBytes: number, done: boolean): void => {
    if (context.emitLive === undefined) return;
    const sample = scpProgressSample({
      localBytes: local.bytes,
      remoteBytes,
      elapsedMs: Date.now() - startedAt,
    });
    context.emitLive("upload", {
      phase: done || remoteBytes > 0 ? "transferring" : "connecting",
      src: plan.src,
      dest: plan.dest,
      excludes: plan.excludes,
      ...(plan.envAtRisk ? { envAtRisk: true } : {}),
      percent: done ? 100 : Math.round(sample.percent * 10) / 10,
      bytesSent: done ? sample.bytesTotal : sample.bytesSent,
      bytesTotal: sample.bytesTotal,
      ...(sample.speed !== null ? { speed: sample.speed } : {}),
      ...(sample.etaSeconds !== null ? { etaSeconds: sample.etaSeconds } : {}),
      filesTotal: local.files,
      filesDone: done ? local.files : 0,
      recentFiles: [],
    });
  };

  emit(0, false);
  let stopped = false;
  let inFlight = false;
  let lastEmitAt = 0;
  const timer =
    dest && context.emitLive !== undefined
      ? setInterval(() => {
          if (stopped || inFlight) return;
          inFlight = true;
          void probeRemoteBytes(buildRemoteSizeProbe(dest.host, dest.path)).then((bytes) => {
            inFlight = false;
            if (stopped) return;
            const now = Date.now();
            if (now - lastEmitAt < SCP_EMIT_FLOOR_MS) return;
            lastEmitAt = now;
            emit(bytes, false);
          });
        }, SCP_POLL_INTERVAL_MS)
      : null;

  const result = await execShellProcess({
    command,
    cwd,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });

  stopped = true;
  if (timer) clearInterval(timer);
  const ok = (result.status === "done" || result.status === "timeout") && (result.exitCode ?? 1) === 0;
  if (ok) emit(local.bytes, true);
  return { command, backend: "scp", result };
}

export const uploadFilesHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const cwd = workspaceRootAbsolute(context.workspacePath);
  const planned = planUploadFiles(args, cwd);
  if (!planned.ok) {
    return failureResult(planned.error, ToolReturnCode.InvalidArguments);
  }
  const plan = planned.plan;
  if (!existsSync(plan.srcPath)) {
    return failureResult(
      `Source path does not exist: ${plan.srcPath}`,
      ToolReturnCode.InvalidArguments,
    );
  }

  // Pick the backend before spawning anything: Windows has no stock rsync, and
  // spawning a missing command surfaced as a raw `'rsync' is not recognized`.
  const rsync = await probeRsyncPrograms(await rsyncProgramCandidates());
  const backend = chooseUploadBackend({
    platform: process.platform,
    plan,
    rsyncAvailable: rsync !== null,
    progress2Supported: rsync?.progress2Supported ?? false,
  });
  if (backend.kind === "error") {
    return failureResult(backend.error, ToolReturnCode.GenericFailure);
  }

  const startedAt = Date.now();
  const run =
    backend.kind === "rsync"
      ? await runRsyncUpload(plan, backend.mode, cwd, context, rsync!.program)
      : await runScpUpload(plan, cwd, context);
  const { command, result } = run;

  if (result.status === "cancelled") {
    return cancelledResult();
  }
  if (result.status === "timeout") {
    return failureResult(
      truncate(
        `transfer timed out after ${UPLOAD_TIMEOUT_MS}ms\n${result.stderr || result.stdout}`,
      ),
      ToolReturnCode.Timeout,
    );
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
    `backend ${run.backend}${
      run.backend === "scp" ? " (rsync is not installed — progress polled over SSH)" : ""
    }`,
    `exit ${exit}${signalName ? ` signal=${signalName}` : ""}`,
    `elapsed ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  ];
  // Collapse the \r-rewritten progress runs — the model (and transcript)
  // only needs the final snapshot line per transfer.
  const stdoutText = collapseProgressLines(result.stdout);
  if (stdoutText) parts.push("--- stdout ---", truncate(stdoutText));
  if (result.stderr) parts.push("--- stderr ---", truncate(result.stderr));

  return textResult(
    parts.join("\n"),
    exit === 0 ? ToolReturnCode.Success : ToolReturnCode.GenericFailure,
  );
};
