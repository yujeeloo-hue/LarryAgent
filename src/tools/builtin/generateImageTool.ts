import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  generateImage,
  imageExtensionForMime,
  saveGeneratedImage,
  sniffImageMime,
} from "../../llm/generateImage.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { imageThumbnailFromBytes } from "../imageThumbnail.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  isAbortError,
  resolveToolPath,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Cap a single input image — Ark seedream rejects >30MB downloads. */
const IMAGE_INPUT_MAX_BYTES = 30 * 1024 * 1024;

/** Default level: 0 — direct execution; cost accepted by the user. */
export const generateImageDefinition: ToolDefinition = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt with the configured ImageGen " +
    "provider (OpenAI Images-compatible). Returns the saved file path and " +
    "shows the image inline.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate.",
      },
      size: {
        type: "string",
        description:
          'Optional image size string — pixels ("1024x1024") or semantic ' +
          'tiers ("1K"/"2K"/"4K" on Volcano Ark seedream). Enums vary by ' +
          "provider; invalid values are rejected by the provider.",
      },
      path: {
        type: "string",
        description:
          "Optional absolute output file path. Defaults to " +
          "{workspace}/.jellybot/generated/img-<timestamp>.<ext>.",
      },
      images: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional input image file paths (1-10) for image-to-image / " +
          "reference-image generation. Only works when the active ImageGen " +
          "profile has image input enabled (e.g. Volcano Ark seedream).",
      },
    },
    required: ["prompt"],
  },
  defaultPermissionLevel: 0,
};

export const generateImageHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return failureResult(
      'Invalid arguments: "prompt" (non-empty string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const size =
    typeof args.size === "string" && args.size.trim()
      ? args.size.trim()
      : undefined;
  const imagePaths = Array.isArray(args.images)
    ? args.images.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
  if (imagePaths.length > 10) {
    return failureResult(
      'Invalid arguments: "images" accepts at most 10 paths.',
      ToolReturnCode.InvalidArguments,
    );
  }

  if (!context.getImageGenClient) {
    return failureResult(
      "Image generation is not available in this runtime.",
      ToolReturnCode.GenericFailure,
    );
  }

  let client;
  try {
    client = await context.getImageGenClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
  if (!client) {
    return failureResult(
      "Image generation is not configured. Set up the ImageGen provider in Setting.",
      ToolReturnCode.GenericFailure,
    );
  }
  if (imagePaths.length > 0 && !client.imageInput) {
    return failureResult(
      "The active ImageGen provider does not declare image input support. " +
        "Enable Image input (Base64 or Cloud Storage URL) on the profile in Setting.",
      ToolReturnCode.GenericFailure,
    );
  }

  // Optional explicit output path (resolved against the workspace).
  let explicitPath: string | null = null;
  if (typeof args.path === "string" && args.path.trim()) {
    const resolved = resolveToolPath(args.path.trim(), {
      workspacePath: context.workspacePath,
      allowOutsideWorkspace: context.fullPermissionsEnabled,
    });
    if (!resolved.ok) {
      return failureResult(resolved.reason, resolved.returnCode);
    }
    explicitPath = resolved.path.absolute;
  }

  // Input images (image-to-image): read each file and encode per the
  // provider mode — inline base64, or object-storage URL upload.
  let wireImages: string[] | undefined;
  if (imagePaths.length > 0) {
    const encoded: string[] = [];
    for (const image of imagePaths) {
      const resolvedImage = resolveToolPath(image, {
        workspacePath: context.workspacePath,
        allowOutsideWorkspace: context.fullPermissionsEnabled,
      });
      if (!resolvedImage.ok) {
        return failureResult(
          resolvedImage.reason,
          resolvedImage.returnCode,
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolvedImage.path.absolute);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failureResult(
          `Cannot read input image ${image}: ${message}`,
          ToolReturnCode.GenericFailure,
        );
      }
      if (bytes.byteLength === 0) {
        return failureResult(
          `Input image ${image} is empty.`,
          ToolReturnCode.GenericFailure,
        );
      }
      if (bytes.byteLength > IMAGE_INPUT_MAX_BYTES) {
        return failureResult(
          `Input image ${image} is too large (${bytes.byteLength} bytes; ` +
            `max ${IMAGE_INPUT_MAX_BYTES}).`,
          ToolReturnCode.GenericFailure,
        );
      }
      const sniffed = sniffImageMime(bytes) ?? "image/png";
      if (client.imageInput === "url") {
        if (!context.uploadImageGenInput) {
          return failureResult(
            "Image input mode is Cloud Storage URL but object storage upload " +
              "is unavailable. Configure Object Storage in Setting or switch " +
              "the profile to Base64.",
            ToolReturnCode.GenericFailure,
          );
        }
        const ext = `.${imageExtensionForMime(sniffed)}`;
        try {
          encoded.push(
            await context.uploadImageGenInput(bytes, sniffed, ext),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return failureResult(
            `Failed to upload input image ${image}: ${message}`,
            ToolReturnCode.GenericFailure,
          );
        }
      } else {
        // Inline base64 — providers expect a data URI (`data:image/...;base64,...`)
        // in the `image` field (Volcano Ark rejects a bare base64 string as an
        // invalid url). Matches the profile `imageInput: "base64"` doc in types.ts.
        encoded.push(
          `data:${sniffed};base64,${Buffer.from(bytes).toString("base64")}`,
        );
      }
    }
    wireImages = encoded;
  }

  try {
    const generated = await generateImage({
      client,
      prompt,
      ...(size ? { size } : {}),
      ...(typeof client.watermark === "boolean"
        ? { watermark: client.watermark }
        : {}),
      ...(wireImages ? { images: wireImages } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    const abortedAfterGen = abortIfSignaled(context.signal);
    if (abortedAfterGen) return abortedAfterGen;

    const saved = explicitPath
      ? (await mkdir(dirname(explicitPath), { recursive: true }),
        await writeFile(explicitPath, generated.bytes),
        {
          filePath: explicitPath,
          sizeBytes: generated.bytes.length,
          mimeType: generated.mimeType,
        })
      : await saveGeneratedImage(
          generated.bytes,
          generated.mimeType,
          `${context.workspacePath.replace(/\/+$/, "")}/.jellybot/generated`,
        );

    const shown = displayPath(saved.filePath);
    // Inline preview for the remote web console — generated bytes are
    // already in memory, no re-read needed (Mac keeps media://).
    const thumbnail = await imageThumbnailFromBytes(
      generated.bytes,
      saved.mimeType,
    );
    return {
      returnCode: ToolReturnCode.Success,
      content: [
        {
          type: "text",
          text: `Generated image saved to ${shown} (${saved.sizeBytes} bytes, ${saved.mimeType}).`,
        },
        {
          type: "attachment",
          kind: "image",
          uri: pathToFileURL(saved.filePath).href,
          name: basename(saved.filePath),
          mimeType: saved.mimeType,
          sizeBytes: saved.sizeBytes,
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
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
