/**
 * Tool RESULT content parsing (CSS-free module): splitting a finished
 * tool's content parts into text / body / file_diff buckets, and deriving
 * true post-apply flash ranges from the file_diff parts. Kept apart from
 * toolInvocationOutputBody (which pulls the highlight.js CSS through
 * DiffLinedFileView) so node-side tests can import it.
 */
import type { AgentFlashRange } from "../../../devmode/agentFlash.js";
import { parseDiffLinesJson } from "./diffTypes.js";
import {
  TOOL_RESULT_BODY_PART_ID,
  TOOL_RESULT_DIFF_PART_ID,
} from "./toolDisplay.js";

export function parseResultContent(content: Array<Record<string, unknown>>): {
  textParts: string[];
  bodyText: string | null;
  diffJson: string | null;
  /** Every file_diff part in order (multi-file patch results). */
  diffJsons: string[];
  /** Explicit per-diff file path (part.path) — aligned with diffJsons. */
  diffPaths: Array<string | undefined>;
  attachmentName?: string;
} {
  const textParts: string[] = [];
  let bodyText: string | null = null;
  let diffJson: string | null = null;
  const diffJsons: string[] = [];
  const diffPaths: Array<string | undefined> = [];
  let attachmentName: string | undefined;

  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      if (part.id === TOOL_RESULT_BODY_PART_ID) {
        bodyText = part.text;
      } else if (part.id === TOOL_RESULT_DIFF_PART_ID) {
        diffJson = part.text;
        diffJsons.push(part.text);
        diffPaths.push(typeof part.path === "string" ? part.path : undefined);
      } else {
        textParts.push(part.text);
      }
    } else if (part.type === "attachment" && typeof part.name === "string") {
      attachmentName = part.name;
    }
  }

  return {
    textParts,
    bodyText,
    diffJson,
    diffJsons,
    diffPaths,
    ...(attachmentName !== undefined ? { attachmentName } : {}),
  };
}

/**
 * True post-apply flash ranges for a finished patch, from the tool
 * RESULT's file_diff parts — the same source the finished card renders.
 * The args-side hunk-header parse drifts whenever the agent based its
 * patch on a stale copy of the file; the applied diff is ground truth.
 * Returns path → ranges (empty map when the result carries no diffs).
 */
export function patchResultFlashRanges(
  content: Array<Record<string, unknown>> | undefined,
): Map<string, AgentFlashRange[]> {
  const out = new Map<string, AgentFlashRange[]>();
  if (!content) return out;
  const { diffJsons, diffPaths, textParts } = parseResultContent(content);
  if (diffJsons.length === 0) return out;
  // Pair each diff with its file: the explicit part.path when the tool
  // emitted one, else a legacy zip with the `Patching/Creating file <path>`
  // report lines. The legacy zip must NOT count `Deleting file` lines —
  // deletes report a line but emit no diff part, which shifted every
  // later pairing onto the wrong file.
  const paths = [
    ...textParts
      .join("\n")
      .matchAll(/^(?:Patching|Creating) file (.+)$/gm),
  ].map((match) => match[1]?.trim() ?? "");
  diffJsons.forEach((diffJson, i) => {
    const path = diffPaths[i] ?? paths[i];
    if (!path) return; // clipped report — never guess a file
    const lines = parseDiffLinesJson(diffJson);
    if (!lines || lines.length === 0) return;
    const ranges: AgentFlashRange[] = [];
    let addRun: { first: number; last: number } | null = null;
    let pendingDel = false;
    let lastNew = 0;
    const flushAdd = (): void => {
      if (addRun) {
        ranges.push({ start: addRun.first, end: addRun.last, kind: "add" });
        addRun = null;
      }
    };
    for (const line of lines) {
      if (line.kind === "add" && line.newLine !== null) {
        // A replacement (del-then-add) anchors the red flash on the line
        // that now stands in the old content's place — same convention as
        // the args-side parser.
        if (pendingDel) {
          ranges.push({ start: line.newLine, end: line.newLine, kind: "del" });
          pendingDel = false;
        }
        if (addRun) addRun.last = line.newLine;
        else addRun = { first: line.newLine, last: line.newLine };
        lastNew = line.newLine;
        continue;
      }
      if (line.kind === "del") {
        flushAdd();
        pendingDel = true;
        continue;
      }
      if (line.newLine !== null) {
        flushAdd();
        if (pendingDel) {
          ranges.push({ start: line.newLine, end: line.newLine, kind: "del" });
          pendingDel = false;
        }
        lastNew = line.newLine;
      }
    }
    flushAdd();
    if (pendingDel) {
      // Deletion at EOF — anchor on the last surviving new-side line.
      const anchor = Math.max(1, lastNew);
      ranges.push({ start: anchor, end: anchor, kind: "del" });
    }
    if (ranges.length > 0) out.set(path, ranges);
  });
  return out;
}

/**
 * Look up a plan file's true ranges. Report paths are absolute
 * (`Patching file /abs/...`) while plan paths are workspace-relative as
 * the agent wrote them — match on exact or path-segment suffix either way.
 */
export function matchFlashRanges(
  map: Map<string, AgentFlashRange[]>,
  path: string,
): AgentFlashRange[] | undefined {
  const exact = map.get(path);
  if (exact) return exact;
  // Suffix match only when it is unambiguous — with both `a.ts` and
  // `x/a.ts` in the map, guessing one flashes the wrong file's lines.
  const candidates = [...map.entries()].filter(
    ([key]) => key.endsWith(`/${path}`) || path.endsWith(`/${key}`),
  );
  return candidates.length === 1 ? candidates[0]![1] : undefined;
}
