import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { imageThumbnailFromFile } from "../imageThumbnail.js";
import {
  runWindowCapture,
  windowCaptureHelperPath,
  type WindowCaptureResponse,
} from "../macos/windowCapture.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  isAbortError,
  resolveToolPath,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

type CaptureRunner = (
  input: {
    appName: string;
    outputPath: string;
    windowTitle?: string;
  },
  signal?: AbortSignal,
) => Promise<WindowCaptureResponse>;

/** Default level: 1 — captures private screen content and writes a PNG. */
export const captureAppWindowDefinition: ToolDefinition = {
  name: "capture_app_window",
  description:
    "Capture the largest visible macOS window for an app to a PNG path.",
  parameters: {
    type: "object",
    properties: {
      app_name: {
        type: "string",
        description: 'Exact app name or bundle id (e.g. "Safari").',
      },
      output: {
        type: "string",
        description: "Absolute path for the output .png file.",
      },
      window_title: {
        type: "string",
        description: "Optional case-insensitive title substring filter.",
      },
    },
    required: ["app_name", "output"],
  },
  defaultPermissionLevel: 1,
};

function returnCodeForCaptureFailure(code: string): number {
  switch (code) {
    case "invalid_arguments":
      return ToolReturnCode.InvalidArguments;
    case "permission_required":
      return ToolReturnCode.PermissionDenied;
    case "app_not_found":
    case "window_not_found":
      return ToolReturnCode.NotFound;
    default:
      return ToolReturnCode.GenericFailure;
  }
}

export function createCaptureAppWindowHandler(
  capture: CaptureRunner = runWindowCapture,
): ToolHandler {
  return async (args, context) => {
    const aborted = abortIfSignaled(context.signal);
    if (aborted) return aborted;

    if (process.platform !== "darwin") {
      return failureResult(
        "capture_app_window is available only on macOS.",
        ToolReturnCode.InvalidArguments,
      );
    }

    const appName =
      typeof args.app_name === "string" && args.app_name.trim()
        ? args.app_name.trim()
        : null;
    const outputArg =
      typeof args.output === "string" && args.output.trim()
        ? args.output.trim()
        : null;
    const windowTitle =
      typeof args.window_title === "string" && args.window_title.trim()
        ? args.window_title.trim()
        : undefined;

    if (!appName || !outputArg) {
      return failureResult(
        'Invalid arguments: "app_name" and "output" (strings) are required.',
        ToolReturnCode.InvalidArguments,
      );
    }

    const resolved = resolveToolPath(outputArg, {
      workspacePath: context.workspacePath,
      allowOutsideWorkspace: context.fullPermissionsEnabled,
    });
    if (!resolved.ok) {
      return failureResult(resolved.reason, resolved.returnCode);
    }

    const outputPath = resolved.path.absolute;
    const shownOutput = displayPath(outputPath);
    if (extname(outputPath).toLowerCase() !== ".png") {
      return failureResult(
        `Output must be a .png path: ${shownOutput}`,
        ToolReturnCode.InvalidArguments,
      );
    }

    try {
      await mkdir(dirname(outputPath), { recursive: true });
      const captureResult = await capture(
        {
          appName,
          outputPath,
          ...(windowTitle ? { windowTitle } : {}),
        },
        context.signal,
      );

      const abortedAfterCapture = abortIfSignaled(context.signal);
      if (abortedAfterCapture) return abortedAfterCapture;

      if (!captureResult.ok) {
        return failureResult(
          captureResult.message,
          returnCodeForCaptureFailure(captureResult.errorCode),
        );
      }

      const info = await stat(outputPath);
      const title = captureResult.windowTitle
        ? ` — ${captureResult.windowTitle}`
        : "";
      // Inline preview for the remote web console (Mac keeps media://).
      const thumbnail = await imageThumbnailFromFile(
        outputPath,
        "image/png",
        info.size,
      );
      return {
        returnCode: ToolReturnCode.Success,
        content: [
          {
            type: "text",
            text:
              `Captured ${captureResult.appName}${title} to ${shownOutput} ` +
              `(${captureResult.width}×${captureResult.height})`,
          },
          {
            type: "attachment",
            kind: "image",
            uri: pathToFileURL(outputPath).href,
            name: basename(outputPath),
            mimeType: "image/png",
            sizeBytes: info.size,
            ...(thumbnail
              ? { thumbnailBase64: thumbnail.base64, thumbnailMimeType: thumbnail.mimeType }
              : {}),
          },
        ],
      };
    } catch (error) {
      if (isAbortError(error) || context.signal?.aborted) {
        return failureResult("Cancelled", ToolReturnCode.Cancelled);
      }
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      if (code === "ENOENT") {
        return failureResult(
          `The macOS window capture helper is unavailable at ${windowCaptureHelperPath()}. Rebuild the app (npm run build) and try again.`,
          ToolReturnCode.NotFound,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return failureResult(
        `Failed to capture ${appName}: ${message}`,
        ToolReturnCode.GenericFailure,
      );
    }
  };
}

export const captureAppWindowHandler = createCaptureAppWindowHandler();
