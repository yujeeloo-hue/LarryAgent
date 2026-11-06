import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { formatWriteFileSuccess } from "../fileWriteLimits.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  resolveToolPath,
  revalidateToolPath,
  textResult,
} from "../pathUtil.js";
import { fileWriteRiskAssessor } from "../policy/fileToolRisk.js";
import {
  FileLockAbortError,
  FileLockTimeoutError,
  fileLockToken,
  withFileLock,
} from "../fileLock.js";

/** Default level: 1 (full-permissions gate). */
export const writeFileDefinition: ToolDefinition = {
  name: "write_file",
  description:
    "Create or overwrite a file at an absolute path. Prefer patch for modifications of existing files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute file path.",
      },
      content: {
        type: "string",
        description: "Full file body to write (overwrites existing content).",
      },
    },
    required: ["path", "content"],
  },
  defaultPermissionLevel: 1,
  assessRisk: fileWriteRiskAssessor,
};

export const writeFileHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const pathArg = typeof args.path === "string" ? args.path : null;
  const content = typeof args.content === "string" ? args.content : null;
  if (pathArg === null || content === null) {
    return failureResult(
      'Invalid arguments: "path" and "content" (strings) are required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const resolved = resolveToolPath(pathArg, {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  });
  if (!resolved.ok) {
    return failureResult(resolved.reason, resolved.returnCode);
  }

  const shown = displayPath(resolved.path.absolute);

  try {
    return await withFileLock(
      resolved.path.absolute,
      "write",
      {
        signal: context.signal,
        adoptToken: context.toolCallId
          ? fileLockToken(context.sessionId, context.toolCallId)
          : undefined,
      },
      async () => {
        const abortedBeforeWrite = abortIfSignaled(context.signal);
        if (abortedBeforeWrite) return abortedBeforeWrite;

        const denied = revalidateToolPath(resolved.path.absolute, context);
        if (denied) return denied;

        await mkdir(dirname(resolved.path.absolute), { recursive: true });
        const abortedAfterMkdir = abortIfSignaled(context.signal);
        if (abortedAfterMkdir) return abortedAfterMkdir;

        const deniedAfterMkdir = revalidateToolPath(resolved.path.absolute, context);
        if (deniedAfterMkdir) return deniedAfterMkdir;

        await writeFile(resolved.path.absolute, Buffer.from(content, "utf8"));
        const abortedAfterWrite = abortIfSignaled(context.signal);
        if (abortedAfterWrite) return abortedAfterWrite;

        // Rich success so later iterations (with stubbed tool_call args) still see
        // that the write landed. UI shows the body from tool_call arguments.
        return textResult(
          formatWriteFileSuccess(shown, content),
          ToolReturnCode.Success,
        );
      },
    );
  } catch (err) {
    if (err instanceof FileLockAbortError) {
      return failureResult("Cancelled", ToolReturnCode.Cancelled);
    }
    if (err instanceof FileLockTimeoutError) {
      return failureResult(
        `${shown} is being written by another flow; timed out waiting for the file lock (${err.message}). Retry shortly.`,
        ToolReturnCode.GenericFailure,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(
      `Failed to write ${shown}: ${message}`,
      ToolReturnCode.GenericFailure,
    );
  }
};
