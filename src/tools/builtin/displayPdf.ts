import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { isPdfPath } from "../fileMeta.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  isAbortError,
  resolveToolPath,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 0 — read-only PDF display in the UI. */
export const displayPdfDefinition: ToolDefinition = {
  name: "display_pdf",
  description: "Show a local PDF inline in the conversation.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to a PDF file.",
      },
    },
    required: ["path"],
  },
  defaultPermissionLevel: 0,
};

export const displayPdfHandler: ToolHandler = async (args, context) => {
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

  const absolute = resolved.path.absolute;
  const shown = displayPath(absolute);

  if (!isPdfPath(absolute)) {
    return failureResult(
      `Unsupported file type: ${shown}. Use a .pdf path.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  try {
    const info = await stat(absolute);
    const abortedAfterStat = abortIfSignaled(context.signal);
    if (abortedAfterStat) return abortedAfterStat;

    if (!info.isFile()) {
      return failureResult(
        `Not a file: ${shown}`,
        ToolReturnCode.InvalidArguments,
      );
    }

    return {
      returnCode: ToolReturnCode.Success,
      content: [
        {
          type: "text",
          text: `Displayed ${shown}`,
        },
        {
          type: "attachment",
          kind: "file",
          uri: pathToFileURL(absolute).href,
          name: basename(absolute),
          mimeType: "application/pdf",
          sizeBytes: info.size,
        },
      ],
    };
  } catch (err) {
    if (isAbortError(err) || context.signal?.aborted) {
      return failureResult("Cancelled", ToolReturnCode.Cancelled);
    }
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return failureResult(`File not found: ${shown}`, ToolReturnCode.NotFound);
    }
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
