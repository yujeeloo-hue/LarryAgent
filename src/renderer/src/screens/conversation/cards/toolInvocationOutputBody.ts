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
    editArgs?: unknown;
    writeContent?: string;
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

  if (typeof options?.writeContent === "string" && returnCode === 0) {
    appendWriteFileContent(body, options.writeContent, pathOrName);
    hasBody = true;
  }

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
      return;
    }
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
