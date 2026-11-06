import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  resolveToolPath,
  revalidateToolPath,
  textResult,
} from "../pathUtil.js";
import {
  FileLockAbortError,
  FileLockTimeoutError,
  withFileLock,
} from "../fileLock.js";

/** Cap on returned content size (not source file size). */
const MAX_BYTES = 128 * 1024;
/** Cap on consecutive lines when `limit` is set. */
const MAX_LIMIT = 2000;

/** Default level: 0. */
export const readFileDefinition: ToolDefinition = {
  name: "read_file",
  description:
    "Read a file at an absolute path (optional offset/limit line range).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute file path.",
      },
      offset: {
        type: "integer",
        description: "1-based start line (omit to start at line 1).",
        minimum: 1,
      },
      limit: {
        type: "integer",
        description: `Line count from offset (max ${MAX_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ["path"],
  },
  defaultPermissionLevel: 0,
};

/** Accept JSON numbers or numeric strings (models often emit strings). */
function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (n > 0) return n;
    }
  }
  return null;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/\r?\n/);
}

function formatRangedBody(
  lines: string[],
  startLine: number,
  endLineInclusive: number,
  totalLines: number,
): string {
  const header = `Lines ${startLine}-${endLineInclusive} of ${totalLines}`;
  const width = String(endLineInclusive).length;
  const body = lines
    .map((line, i) => {
      const n = String(startLine + i).padStart(width, " ");
      return `${n}|${line}`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateToMaxBytes(text: string, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  if (utf8ByteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  // Avoid cutting mid-code-point.
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Read up to `maxBytes` of file content (prefix). Does not reject large files.
 */
async function readFilePrefix(
  absolute: string,
  maxBytes: number,
  fileSize: number,
): Promise<{ text: string; truncated: boolean }> {
  if (fileSize <= maxBytes) {
    const buf = await open(absolute, "r").then(async (fh) => {
      try {
        return await fh.readFile();
      } finally {
        await fh.close();
      }
    });
    if (buf.includes(0)) {
      throw Object.assign(new Error("binary"), { code: "BINARY" });
    }
    return { text: buf.toString("utf8"), truncated: false };
  }

  const fh = await open(absolute, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    const slice = buf.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw Object.assign(new Error("binary"), { code: "BINARY" });
    }
    return { text: slice.toString("utf8"), truncated: true };
  } finally {
    await fh.close();
  }
}

/**
 * Stream the file once: collect the requested line slice (capped by maxBytes
 * of formatted output) and count total lines.
 */
async function readLineRange(
  absolute: string,
  startLine: number,
  limit: number | undefined,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{
  lines: string[];
  startLine: number;
  endLine: number;
  totalLines: number;
  truncatedByBytes: boolean;
}> {
  const rl = createInterface({
    input: createReadStream(absolute, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const collected: string[] = [];
  let lineNo = 0;
  let truncatedByBytes = false;
  let probe = "";

  try {
    for await (const line of rl) {
      if (signal?.aborted) {
        throw Object.assign(new Error("Cancelled"), { code: "ABORT" });
      }
      lineNo += 1;

      // Cheap binary probe on early content.
      if (lineNo <= 20) {
        probe += `${line}\n`;
        if (probe.includes("\0")) {
          throw Object.assign(new Error("binary"), { code: "BINARY" });
        }
      }

      const inRange =
        lineNo >= startLine &&
        (limit === undefined || collected.length < limit);
      if (!inRange || truncatedByBytes) {
        continue;
      }

      const next = [...collected, line];
      const endLine = startLine + next.length - 1;
      // totalLines unknown while streaming; use a lower-bound for width/format check.
      const formatted = formatRangedBody(next, startLine, endLine, Math.max(endLine, lineNo));
      if (utf8ByteLength(formatted) > maxBytes) {
        if (collected.length === 0) {
          // Single line alone exceeds cap — keep a truncated line.
          const header = `Lines ${startLine}-${startLine} of ?`;
          const budget = Math.max(16, maxBytes - utf8ByteLength(`${header}\n${startLine}|`));
          const clipped = truncateToMaxBytes(line, budget).text;
          collected.push(clipped);
          truncatedByBytes = true;
        } else {
          truncatedByBytes = true;
        }
        continue;
      }
      collected.push(line);
    }
  } finally {
    rl.close();
  }

  const totalLines = lineNo;
  const endLine =
    collected.length === 0 ? startLine - 1 : startLine + collected.length - 1;
  return {
    lines: collected,
    startLine,
    endLine,
    totalLines,
    truncatedByBytes,
  };
}

export const readFileHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const pathArg = typeof args.path === "string" ? args.path : null;
  if (pathArg === null) {
    return failureResult(
      'Invalid arguments: "path" (absolute string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const hasOffset = args.offset !== undefined && args.offset !== null;
  const hasLimit = args.limit !== undefined && args.limit !== null;

  let offset: number | undefined;
  let limit: number | undefined;

  if (hasOffset) {
    const parsed = parsePositiveInt(args.offset);
    if (parsed === null) {
      return failureResult(
        'Invalid arguments: "offset" must be a positive integer (1-based line).',
        ToolReturnCode.InvalidArguments,
      );
    }
    offset = parsed;
  }

  if (hasLimit) {
    const parsed = parsePositiveInt(args.limit);
    if (parsed === null) {
      return failureResult(
        'Invalid arguments: "limit" must be a positive integer.',
        ToolReturnCode.InvalidArguments,
      );
    }
    if (parsed > MAX_LIMIT) {
      return failureResult(
        `Invalid arguments: "limit" max is ${MAX_LIMIT}.`,
        ToolReturnCode.InvalidArguments,
      );
    }
    limit = parsed;
  }

  const ranged = offset !== undefined || limit !== undefined;

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
      "read",
      { signal: context.signal },
      async () => {
        const denied = revalidateToolPath(resolved.path.absolute, context);
        if (denied) return denied;
        const info = await stat(resolved.path.absolute);
        const abortedAfterStat = abortIfSignaled(context.signal);
        if (abortedAfterStat) return abortedAfterStat;

        if (!info.isFile()) {
          return failureResult(
            `Not a file: ${shown}`,
            ToolReturnCode.InvalidArguments,
          );
        }

        const deniedAfterStat = revalidateToolPath(resolved.path.absolute, context);
        if (deniedAfterStat) return deniedAfterStat;

        if (!ranged) {
          const { text, truncated } = await readFilePrefix(
            resolved.path.absolute,
            MAX_BYTES,
            info.size,
          );
          const abortedAfterRead = abortIfSignaled(context.signal);
          if (abortedAfterRead) return abortedAfterRead;

          if (!truncated) {
            return textResult(text, ToolReturnCode.Success);
          }
          return textResult(
            `${text}\n\n[Truncated: returned first ${MAX_BYTES} bytes of ${info.size}-byte file]`,
            ToolReturnCode.Success,
          );
        }

        const startLine = offset ?? 1;
        const range = await readLineRange(
          resolved.path.absolute,
          startLine,
          limit,
          MAX_BYTES,
          context.signal,
        );
        const abortedAfterRead = abortIfSignaled(context.signal);
        if (abortedAfterRead) return abortedAfterRead;

        if (startLine > range.totalLines) {
          return textResult(
            `Lines none (offset ${startLine} beyond end; file has ${range.totalLines} line${range.totalLines === 1 ? "" : "s"})`,
            ToolReturnCode.Success,
          );
        }

        let body = formatRangedBody(
          range.lines,
          range.startLine,
          range.endLine,
          range.totalLines,
        );
        if (range.truncatedByBytes) {
          body += `\n\n[Truncated: returned content capped at ${MAX_BYTES} bytes]`;
        }
        // Final safety clamp (e.g. notice tip pushed over).
        const clamped = truncateToMaxBytes(body, MAX_BYTES + 128);
        return textResult(clamped.text, ToolReturnCode.Success);
      },
    );
  } catch (err) {
    if (err instanceof FileLockAbortError) {
      return failureResult("Cancelled", ToolReturnCode.Cancelled);
    }
    if (err instanceof FileLockTimeoutError) {
      // File is being written (possibly still streaming args / awaiting
      // permission approval in another flow) — explicit retryable signal.
      return failureResult(
        `${shown} is being written; timed out waiting for the write to finish. Retry shortly.`,
        ToolReturnCode.GenericFailure,
      );
    }
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "BINARY") {
      return failureResult(
        `Refusing to read binary file: ${shown}`,
        ToolReturnCode.InvalidArguments,
      );
    }
    if (code === "ABORT" || code === "ERR_STREAM_PREMATURE_CLOSE") {
      return failureResult("Cancelled", ToolReturnCode.Cancelled);
    }
    if (code === "ENOENT") {
      return failureResult(`File not found: ${shown}`, ToolReturnCode.NotFound);
    }
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
