import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteResult, ToolRiskRewrite } from "../types.js";


export const TRASH_GLOB_LIMIT = 4096;

async function electronTrashItem(path: string): Promise<void> {
  const electron = await import("electron");
  await electron.shell.trashItem(path);
}

let trashMover: (path: string) => Promise<void> = electronTrashItem;

export function configureTrashMover(mover: (path: string) => Promise<void>): void {
  trashMover = mover;
}

export function resetTrashMoverForTests(): void {
  trashMover = electronTrashItem;
}

type ExpandedTargets =
  | { ok: true; targets: string[] }
  | { ok: false; lines: string[] };

async function expandTargets(
  targets: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ExpandedTargets> {
  const out: string[] = [];
  for (const target of targets) {
    if (signal?.aborted) return { ok: false, lines: [] };
    if (!/[*?]/.test(target)) {
      out.push(target);
      continue;
    }
    const matches: string[] = [];
    try {
      for await (const m of glob(target)) {
        matches.push(m);
        if (matches.length > TRASH_GLOB_LIMIT) break;
      }
    } catch {
      return {
        ok: false,
        lines: [`rm: failed to expand ${target}: invalid pattern`],
      };
    }
    if (matches.length > TRASH_GLOB_LIMIT) {
      return {
        ok: false,
        lines: [
          `rm: ${target}: glob expansion exceeds ${TRASH_GLOB_LIMIT} matches — nothing was deleted`,
          `Narrow the pattern or delete in smaller batches so deletions can be routed to the Trash.`,
        ],
      };
    }
    if (matches.length === 0) {
      if (signal?.aborted) return { ok: false, lines: [] };
      return {
        ok: false,
        lines: [`rm: no matches found: ${target}`],
      };
    }
    out.push(...matches);
  }
  return { ok: true, targets: out };
}

export function executeTrashRewrite(
  rewrite: ToolRiskRewrite,
  signal?: AbortSignal,
  trashItem: (path: string) => Promise<void> = (path) => trashMover(path),
  assertPath?: (path: string) => void,
): Promise<ToolExecuteResult> {
  return (async () => {
    if (signal?.aborted) {
      return cancelled();
    }

    const lines: string[] = [`$ ${rewrite.originalCommand}`];
    let anyFailure = false;

    const expanded = await expandTargets(rewrite.targets, signal);
    if (signal?.aborted) return cancelled();
    if (!expanded.ok) {
      if (expanded.lines.length === 0) return cancelled();
      lines.push(...expanded.lines);
      lines.push("exit 1 (Trash rewrite)");
      return {
        returnCode: ToolReturnCode.GenericFailure,
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }

    for (const target of expanded.targets) assertPath?.(target);
    for (const target of expanded.targets) {
      if (signal?.aborted) return cancelled();
      if (!existsSync(target)) {
        if (rewrite.force) continue;
        anyFailure = true;
        lines.push(`rm: ${target}: No such file or directory`);
        continue;
      }
      try {
        await trashItem(target);
        lines.push(`moved to Trash: ${target}`);
      } catch (err) {
        anyFailure = true;
        const message = err instanceof Error ? err.message : String(err);
        lines.push(`rm: failed to move ${target} to Trash: ${message}`);
      }
    }

    lines.push(
      anyFailure ? "exit 1 (Trash rewrite)" : "exit 0 (Trash rewrite)",
    );
    return {
      returnCode: anyFailure
        ? ToolReturnCode.GenericFailure
        : ToolReturnCode.Success,
      content: [{ type: "text", text: lines.join("\n") }],
    };
  })();
}

function cancelled(): ToolExecuteResult {
  return {
    returnCode: ToolReturnCode.Cancelled,
    content: [{ type: "text", text: "Cancelled" }],
  };
}
