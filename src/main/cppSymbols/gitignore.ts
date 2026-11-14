import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execGit } from "../../git/execGit.js";
import { agentLogInfo, agentLogWarn } from "../../logging/agentLog.js";
import {
  CPP_SYMBOL_GITIGNORE_COMMENT,
  CPP_SYMBOL_GITIGNORE_LINES,
} from "./types.js";

function lineSet(content: string): Set<string> {
  const lines = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    lines.add(trimmed);
  }
  return lines;
}

/** True when `.gitignore` already ignores the sqlite file and its WAL sidecars. */
export function gitignoreHasCppSymbolEntries(content: string): boolean {
  const lines = lineSet(content);
  return CPP_SYMBOL_GITIGNORE_LINES.every((entry) => lines.has(entry));
}

/**
 * Append the symbol-database paths to the workspace `.gitignore` and
 * untrack them if they were committed. Best-effort: never throws.
 */
export async function ensureCppSymbolGitignored(
  workspacePath: string,
): Promise<void> {
  const root = workspacePath.trim();
  if (!root) return;
  try {
    const ignoreFile = join(root, ".gitignore");
    let existing = "";
    try {
      existing = await readFile(ignoreFile, "utf8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") throw err;
    }
    const present = lineSet(existing);
    const missing = CPP_SYMBOL_GITIGNORE_LINES.filter(
      (entry) => !present.has(entry),
    );
    if (missing.length > 0) {
      let next = existing;
      if (next.length > 0 && !next.endsWith("\n")) next += "\n";
      if (next.length > 0) next += "\n";
      if (!existing.includes(CPP_SYMBOL_GITIGNORE_COMMENT)) {
        next += `${CPP_SYMBOL_GITIGNORE_COMMENT}\n`;
      }
      next += `${missing.join("\n")}\n`;
      await writeFile(ignoreFile, next, "utf8");
      agentLogInfo("cpp_symbols.gitignore_appended", { workspacePath: root });
    }

    try {
      await execGit(root, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return;
    }
    for (const relative of CPP_SYMBOL_GITIGNORE_LINES) {
      try {
        const { stdout } = await execGit(root, ["ls-files", "--", relative]);
        if (!stdout.trim()) continue;
        await execGit(root, ["rm", "--cached", "-f", "--", relative]);
        agentLogInfo("cpp_symbols.git_untracked", {
          workspacePath: root,
          path: relative,
        });
      } catch (err) {
        agentLogWarn("cpp_symbols.git_untrack_failed", {
          workspacePath: root,
          path: relative,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    agentLogWarn("cpp_symbols.gitignore_failed", {
      workspacePath: root,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
