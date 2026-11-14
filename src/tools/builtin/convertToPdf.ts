import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  printHtmlToPdf,
  wrapMarkdownHtmlDocument,
} from "../pdf/printHtmlToPdf.js";
import { isPdfPath } from "../fileMeta.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  isAbortError,
  resolveToolPath,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

const INPUT_EXTS = new Set([".html", ".htm", ".md", ".markdown"]);

function isConvertiblePath(path: string): boolean {
  return INPUT_EXTS.has(extname(path).toLowerCase());
}

/** Default level: 1 (full-permissions gate) — writes a PDF. */
export const convertToPdfDefinition: ToolDefinition = {
  name: "convert_to_pdf",
  description: "Convert a local HTML or Markdown file to PDF.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the source .html/.htm/.md file.",
      },
      output: {
        type: "string",
        description: "Absolute path for the output .pdf file.",
      },
    },
    required: ["path", "output"],
  },
  defaultPermissionLevel: 1,
};

export const convertToPdfHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const pathArg = typeof args.path === "string" ? args.path : null;
  const outputArg = typeof args.output === "string" ? args.output : null;
  if (pathArg === null || outputArg === null) {
    return failureResult(
      'Invalid arguments: "path" and "output" (absolute strings) are required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const pathOpts = {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  };

  const resolvedIn = resolveToolPath(pathArg, pathOpts);
  if (!resolvedIn.ok) {
    return failureResult(resolvedIn.reason, resolvedIn.returnCode);
  }
  const resolvedOut = resolveToolPath(outputArg, pathOpts);
  if (!resolvedOut.ok) {
    return failureResult(resolvedOut.reason, resolvedOut.returnCode);
  }

  const inputPath = resolvedIn.path.absolute;
  const outputPath = resolvedOut.path.absolute;
  const shownIn = displayPath(inputPath);
  const shownOut = displayPath(outputPath);

  if (!isConvertiblePath(inputPath)) {
    return failureResult(
      `Unsupported input type: ${shownIn}. Use .html, .htm, or .md.`,
      ToolReturnCode.InvalidArguments,
    );
  }
  if (!isPdfPath(outputPath)) {
    return failureResult(
      `Output must be a .pdf path: ${shownOut}`,
      ToolReturnCode.InvalidArguments,
    );
  }

  try {
    const abortedBeforeRead = abortIfSignaled(context.signal);
    if (abortedBeforeRead) return abortedBeforeRead;

    const ext = extname(inputPath).toLowerCase();
    let pdf: Buffer;

    if (ext === ".md" || ext === ".markdown") {
      const raw = await readFile(inputPath, "utf8");
      const abortedAfterRead = abortIfSignaled(context.signal);
      if (abortedAfterRead) return abortedAfterRead;

      const body = await marked.parse(raw);
      const html = wrapMarkdownHtmlDocument(body);
      pdf = await printHtmlToPdf({
        html,
        assetBaseDir: dirname(inputPath),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } else {
      pdf = await printHtmlToPdf({
        htmlFilePath: inputPath,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }

    const abortedBeforeWrite = abortIfSignaled(context.signal);
    if (abortedBeforeWrite) return abortedBeforeWrite;

    await mkdir(dirname(outputPath), { recursive: true });
    const abortedAfterMkdir = abortIfSignaled(context.signal);
    if (abortedAfterMkdir) return abortedAfterMkdir;

    await writeFile(outputPath, pdf);
    const abortedAfterWrite = abortIfSignaled(context.signal);
    if (abortedAfterWrite) return abortedAfterWrite;

    const info = await stat(outputPath);

    return {
      returnCode: ToolReturnCode.Success,
      content: [
        {
          type: "text",
          text: `Wrote ${shownOut}`,
        },
        {
          type: "attachment",
          kind: "file",
          uri: pathToFileURL(outputPath).href,
          name: basename(outputPath),
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
      return failureResult(`File not found: ${shownIn}`, ToolReturnCode.NotFound);
    }
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(
      `Failed to convert ${shownIn}: ${message}`,
      ToolReturnCode.GenericFailure,
    );
  }
};
