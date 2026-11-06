import { parseMarkdownBlocks } from "../../../markdown/parseMarkdownBlocks.js";
import { pathFromToolHeadline, isMarkdownPathOrName } from "./codeHighlight.js";
import { createDiffLinedFileView } from "./DiffLinedFileView.js";
import { parseDiffLinesJson } from "./diffTypes.js";
import { buildHunkLineDiff, editStringsFromArgs } from "./buildHunkDiff.js";
import { createLinedFileView } from "./LinedFileView.js";
import { renderMarkdownBlocks } from "./MarkdownBlocksView.js";
import { renderMarkdownText } from "../renderMarkdownText.js";
import { returnCodeLabel } from "./toolInvocationHelpers.js";

export function appendWriteFileContent(
  body: HTMLElement,
  content: string,
  pathOrName: string | undefined,
  options?: { streaming?: boolean },
): void {
  if (isMarkdownPathOrName(pathOrName)) {
    const container = document.createElement("div");
    container.className = "md-blocks content-card-write-markdown";
    renderMarkdownText(content, container, {
      ...(options?.streaming === true ? { streaming: true } : {}),
    });
    body.append(container);
    return;
  }
  body.append(
    createLinedFileView(content, {
      ...(pathOrName !== undefined ? { pathOrName } : {}),
    }),
  );
}

import { parseResultContent } from "./resultContent.js";

export { parseResultContent, } from "./resultContent.js";

export function appendOutputBody(
  body: HTMLElement,
  parsed: ReturnType<typeof parseResultContent>,
  returnCode: number,
  pathHint?: string,
  options?: {
    foldUnchanged?: boolean;
    /** When result has no stored diff, rebuild edit hunk from tool args. */
    editArgs?: unknown;
    /**
     * write_file body from tool args (or legacy file_body). Lined code for
     * source files; rendered Markdown for .md / .markdown / .mdx.
     */
    writeContent?: string;
    /**
     * Per-file diff parts to render sequentially (multi-file patch results).
     * When provided and non-empty, supersedes the single-diff path.
     */
    diffEntries?: { pathOrName?: string; diffJson: string }[];
  },
): void {
  const { textParts, bodyText, diffJson, diffJsons, attachmentName } = parsed;
  const headline = textParts[0] ?? "";
  const pathOrName =
    pathHint ??
    pathFromToolHeadline(headline) ??
    attachmentName;

  let hasBody = false;

  // write_file: lined view or markdown (ignore legacy full-file diffs).
  if (typeof options?.writeContent === "string" && returnCode === 0) {
    appendWriteFileContent(body, options.writeContent, pathOrName);
    hasBody = true;
  }

  // Multi-file patch: one diff view per file_diff part, in result order.
  if (!hasBody && options?.diffEntries && options.diffEntries.length > 0) {
    for (const entry of options.diffEntries) {
      const lines = parseDiffLinesJson(entry.diffJson);
      if (!lines || lines.length === 0) continue;
      body.append(
        createDiffLinedFileView(lines, {
          ...(entry.pathOrName !== undefined
            ? { pathOrName: entry.pathOrName }
            : {}),
          ...(options.foldUnchanged !== undefined
            ? { foldUnchanged: options.foldUnchanged }
            : {}),
        }),
      );
      hasBody = true;
    }
    if (hasBody && returnCode === 0) {
      // Success: headline + per-file lines already live on the card summary.
      return;
    }
    // Failure / rejects: fall through so excerpt text parts render below.
  }

  let diffLines =
    !hasBody && diffJson ? parseDiffLinesJson(diffJson) : null;
  if ((!diffLines || diffLines.length === 0) && returnCode === 0 && !hasBody) {
    const edit = editStringsFromArgs(options?.editArgs);
    if (edit) {
      diffLines = buildHunkLineDiff(edit.oldString, edit.newString);
    }
  }

  if (!hasBody && diffLines && diffLines.length > 0) {
    body.append(
      createDiffLinedFileView(diffLines, {
        ...(pathOrName !== undefined ? { pathOrName } : {}),
        ...(options?.foldUnchanged !== undefined
          ? { foldUnchanged: options.foldUnchanged }
          : {}),
      }),
    );
    hasBody = true;
  } else if (!hasBody && bodyText !== null) {
    if (isMarkdownPathOrName(pathOrName)) {
      appendWriteFileContent(body, bodyText, pathOrName);
    } else {
      body.append(
        createLinedFileView(bodyText, {
          ...(pathOrName !== undefined ? { pathOrName } : {}),
        }),
      );
    }
    hasBody = true;
  } else if (!hasBody && textParts.length > 0) {
    // Deduplicate identical text parts (avoids repeated error lines).
    const uniqueParts: string[] = [];
    for (const part of textParts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (uniqueParts.some((existing) => existing.trim() === trimmed)) continue;
      uniqueParts.push(part);
    }
    const md = document.createElement("div");
    renderMarkdownBlocks(parseMarkdownBlocks(uniqueParts.join("\n\n")), md);
    body.append(md);
    hasBody = true;
  }

  if (!hasBody) {
    const empty = document.createElement("p");
    empty.className = "md-paragraph";
    empty.textContent = returnCodeLabel(returnCode);
    body.append(empty);
  }
}
