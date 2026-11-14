import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { recognizeImage } from "../../llm/recognizeImage.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { imageThumbnailFromFile } from "../imageThumbnail.js";
import {
  guessMimeType,
  isSvgMimeType,
  isSvgPath,
  isVisionImagePath,
} from "../fileMeta.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  isAbortError,
  resolveToolPath,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Max image bytes sent to the vision model (base64 expands ~4/3). */
const MAX_BYTES = 8 * 1024 * 1024;

/** Default level: 0 — read-only image understanding. */
export const readImageDefinition: ToolDefinition = {
  name: "read_image",
  description:
    "Describe a local raster image with a vision model (png/jpg/gif/webp). Not SVG — SVG is XML markup, use read_file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to a raster image (png/jpg/jpeg/gif/webp). Not SVG.",
      },
      question: {
        type: "string",
        description: "Optional focus question for the vision model.",
      },
    },
    required: ["path"],
  },
  defaultPermissionLevel: 0,
};

export const readImageHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const pathArg = typeof args.path === "string" ? args.path : null;
  if (pathArg === null) {
    return failureResult(
      'Invalid arguments: "path" (absolute string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const question =
    typeof args.question === "string" && args.question.trim()
      ? args.question.trim()
      : undefined;

  const resolved = resolveToolPath(pathArg, {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  });
  if (!resolved.ok) {
    return failureResult(resolved.reason, resolved.returnCode);
  }

  const absolute = resolved.path.absolute;
  const shown = displayPath(absolute);

  if (isSvgPath(absolute) || isSvgMimeType(guessMimeType(absolute))) {
    return failureResult(
      `SVG is XML markup, not a vision image: ${shown}. Use read_file (and display_image to show it).`,
      ToolReturnCode.InvalidArguments,
    );
  }
  if (!isVisionImagePath(absolute)) {
    return failureResult(
      `Unsupported image type: ${shown}. Use png, jpg, jpeg, gif, or webp.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  // Direct path (tool-role images): the session provider accepts images
  // inside tool results — put the pixels on the model wire instead of
  // relaying a vision-model description. Runs BEFORE the vision gate on
  // purpose (direct mode needs no Vision profile); any failure here
  // degrades to the relay path below.
  if (context.uploadReadImage) {
    try {
      const info = await stat(absolute);
      if (
        info.isFile() &&
        info.size <= MAX_BYTES &&
        !abortIfSignaled(context.signal)
      ) {
        const mimeType = guessMimeType(absolute);
        let uploaded: { url: string; key: string } | null = null;
        try {
          uploaded = await context.uploadReadImage({
            imagePath: absolute,
            mimeType,
          });
        } catch {
          uploaded = null;
        }
        const abortedAfterUpload = abortIfSignaled(context.signal);
        if (abortedAfterUpload) return abortedAfterUpload;

        if (uploaded) {
          // Null-safe inline preview (remote web console); failures omit it.
          const thumbnail = await imageThumbnailFromFile(
            absolute,
            mimeType,
            info.size,
          );
          return {
            returnCode: ToolReturnCode.Success,
            content: [
              {
                type: "text",
                text: `[Image "${basename(absolute)}" at absolute path "${absolute}" attached in this tool result${question ? ` — focus: ${question}` : ""}. Analyze the attached image directly; pass this path to other tools when the file itself is needed.]`,
              },
              {
                type: "attachment",
                kind: "image",
                uri: absolute,
                name: basename(absolute),
                mimeType,
                sizeBytes: info.size,
                s3: { url: uploaded.url, key: uploaded.key },
                ...(thumbnail
                  ? {
                      thumbnailBase64: thumbnail.base64,
                      thumbnailMimeType: thumbnail.mimeType,
                    }
                  : {}),
              },
            ],
          };
        }
      }
    } catch {
      // Missing file / oversize — let the relay path below report it.
    }
  }

  if (!context.getVisionClient) {
    return failureResult(
      "Vision model is not available in this runtime.",
      ToolReturnCode.GenericFailure,
    );
  }

  let visionClient;
  try {
    visionClient = await context.getVisionClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(message, ToolReturnCode.GenericFailure);
  }

  if (!visionClient) {
    return failureResult(
      "No vision-capable model available. Enable Supports multimodal on the chat provider, or configure the Vision profile in Setting.",
      ToolReturnCode.GenericFailure,
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
    if (info.size > MAX_BYTES) {
      return failureResult(
        `Image too large (${info.size} bytes; max ${MAX_BYTES}): ${shown}`,
        ToolReturnCode.InvalidArguments,
      );
    }

    const mimeType = guessMimeType(absolute);

    const description = await recognizeImage({
      client: visionClient,
      imagePath: absolute,
      mimeType,
      ...(question ? { question } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    const abortedAfterVision = abortIfSignaled(context.signal);
    if (abortedAfterVision) return abortedAfterVision;

    return textResult(description, ToolReturnCode.Success);
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
