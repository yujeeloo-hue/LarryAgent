import { readdir } from "node:fs/promises";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  resolveToolPath,
  textResult,
} from "../pathUtil.js";

/** Default level: 0. */
export const listDirDefinition: ToolDefinition = {
  name: "list_dir",
  description: "List files and directories at an absolute path.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute directory path.",
      },
    },
    required: ["path"],
  },
  defaultPermissionLevel: 0,
};

export const listDirHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const pathArg = typeof args.path === "string" ? args.path : null;
  if (pathArg === null) {
    return failureResult(
      'Invalid arguments: "path" (absolute string) is required.',
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
    const entries = await readdir(resolved.path.absolute, {
      withFileTypes: true,
    });
    const abortedAfter = abortIfSignaled(context.signal);
    if (abortedAfter) return abortedAfter;

    const lines = entries
      .slice()
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((entry) => {
        const kind = entry.isDirectory()
          ? "dir"
          : entry.isSymbolicLink()
            ? "link"
            : "file";
        return `${kind}\t${entry.name}`;
      });

    const header = `list_dir ${shown} (${lines.length})`;
    const body = lines.length > 0 ? lines.join("\n") : "(empty)";
    return textResult(`${header}\n${body}`, ToolReturnCode.Success);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return failureResult(
        `Directory not found: ${shown}`,
        ToolReturnCode.NotFound,
      );
    }
    if (code === "ENOTDIR") {
      return failureResult(
        `Not a directory: ${shown}`,
        ToolReturnCode.InvalidArguments,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
