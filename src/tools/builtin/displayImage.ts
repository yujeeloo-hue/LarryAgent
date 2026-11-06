import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { guessMimeType, isDisplayImagePath } from "../fileMeta.js";
import { imageThumbnailFromFile } from "../imageThumbnail.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  isAbortError,
  resolveToolPath,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 0 — read-only image display in the UI. */
export const displayImageDefinition: ToolDefinition = {
  name: "display_image",
  description: "Show a local image inline (png/jpg/gif/webp/svg).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to an image file.",
      },
    },
    required: ["path"],
  },
  defaultPermissionLevel: 0,
};

export const displayImageHandler: ToolHandler = async (args, context) => {
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

  if (!isDisplayImagePath(absolute)) {
    return failureResult(
      `Unsupported image type: ${shown}. Use png, jpg, jpeg, gif, webp, or svg.`,
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

    const mimeType = guessMimeType(absolute);
    // Inline preview for the remote web console (Mac keeps loading the
    // original via media://). Null-safe: no decoder / oversize / decode
    // failure simply omits the fields.
    const thumbnail = await imageThumbnailFromFile(absolute, mimeType, info.size);

    return {
      returnCode: ToolReturnCode.Success,
      content: [
        {
          type: "text",
          text: `Displayed ${shown}`,
        },
        {
          type: "attachment",
          kind: "image",
          uri: pathToFileURL(absolute).href,
          name: basename(absolute),
          mimeType,
          sizeBytes: info.size,
          ...(thumbnail
            ? { thumbnailBase64: thumbnail.base64, thumbnailMimeType: thumbnail.mimeType }
            : {}),
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
