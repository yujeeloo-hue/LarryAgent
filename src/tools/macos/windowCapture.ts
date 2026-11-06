import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const CAPTURE_TIMEOUT_MS = 30_000;
const MAX_HELPER_OUTPUT_CHARS = 64_000;

export type WindowCaptureInput = {
  appName: string;
  outputPath: string;
  windowTitle?: string;
};

export type WindowCaptureSuccess = {
  ok: true;
  path: string;
  appName: string;
  windowTitle?: string;
  windowId: number;
  width: number;
  height: number;
};

export type WindowCaptureFailure = {
  ok: false;
  errorCode:
    | "invalid_arguments"
    | "permission_required"
    | "app_not_found"
    | "window_not_found"
    | "capture_failed";
  message: string;
};

export type WindowCaptureResponse =
  | WindowCaptureSuccess
  | WindowCaptureFailure;

/**
 * Resolve the ScreenCaptureKit helper binary.
 *
 * Electron always sets `process.resourcesPath` (even in unpackaged preview/dev),
 * but the helper is only copied into app Resources when packaged. Prefer any
 * candidate that actually exists on disk.
 */
export function windowCaptureHelperPath(): string {
  const override = process.env.WINDOW_CAPTURE_HELPER_PATH?.trim();
  if (override) return resolve(override);

  const candidates = [
    // Packaged .app: extraResources → Contents/Resources/helpers/…
    ...(typeof process.resourcesPath === "string" && process.resourcesPath
      ? [join(process.resourcesPath, "helpers", "macos-window-capture")]
      : []),
    // Dev / electron-vite preview: built by build-window-capture.mjs
    join(process.cwd(), "build", "helpers", "macos-window-capture"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to the unpackaged build path for a clearer ENOENT message.
  return join(process.cwd(), "build", "helpers", "macos-window-capture");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

export function parseWindowCaptureResponse(raw: string): WindowCaptureResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error("Window capture helper returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Window capture helper returned an invalid response.");
  }

  const record = parsed as Record<string, unknown>;
  if (record.ok === true) {
    const path = nonEmptyString(record.path);
    const appName = nonEmptyString(record.appName);
    const windowId = finiteInteger(record.windowId);
    const width = finiteInteger(record.width);
    const height = finiteInteger(record.height);
    if (
      !path ||
      !appName ||
      windowId === undefined ||
      width === undefined ||
      height === undefined
    ) {
      throw new Error("Window capture helper returned incomplete image metadata.");
    }
    const windowTitle = nonEmptyString(record.windowTitle);
    return {
      ok: true,
      path,
      appName,
      ...(windowTitle ? { windowTitle } : {}),
      windowId,
      width,
      height,
    };
  }

  const knownCodes = new Set<WindowCaptureFailure["errorCode"]>([
    "invalid_arguments",
    "permission_required",
    "app_not_found",
    "window_not_found",
    "capture_failed",
  ]);
  const code = nonEmptyString(record.errorCode);
  const message = nonEmptyString(record.message);
  if (
    record.ok !== false ||
    !code ||
    !knownCodes.has(code as WindowCaptureFailure["errorCode"]) ||
    !message
  ) {
    throw new Error("Window capture helper returned an invalid error response.");
  }
  return {
    ok: false,
    errorCode: code as WindowCaptureFailure["errorCode"],
    message,
  };
}

export async function runWindowCapture(
  input: WindowCaptureInput,
  signal?: AbortSignal,
): Promise<WindowCaptureResponse> {
  const args = ["--app", input.appName, "--output", input.outputPath];
  if (input.windowTitle) {
    args.push("--window-title", input.windowTitle);
  }

  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(windowCaptureHelperPath(), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (
      callback: () => void,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      const error = new Error("Window capture cancelled.");
      error.name = "AbortError";
      finish(() => reject(error));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CAPTURE_TIMEOUT_MS);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_HELPER_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_HELPER_OUTPUT_CHARS) stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", () => {
      finish(() => {
        if (timedOut) {
          reject(new Error("Window capture timed out."));
          return;
        }
        try {
          if (!stdout.trim()) {
            const detail = stderr.trim() || "Window capture helper produced no output."
            reject(new Error(detail));
            return;
          }
          resolvePromise(parseWindowCaptureResponse(stdout));
        } catch (error) {
          const detail = stderr.trim();
          if (detail && error instanceof Error) {
            reject(new Error(`${error.message} ${detail}`));
          } else {
            reject(error);
          }
        }
      });
    });
  });
}
