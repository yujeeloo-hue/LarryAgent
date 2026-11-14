import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execGit } from "../git/execGit.js";
import { agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import {
  PROJECT_DOCS_DIR,
  PROJECT_DOC_FILENAMES,
  PROJECT_MEMORY_FILENAME,
  type ProjectDocId,
} from "./types.js";

const GITIGNORE_COMMENT = "# Agent project memory (local; do not commit)";

function lineIgnoresProjectMd(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  return (
    trimmed === "PROJECT.md" ||
    trimmed === "/PROJECT.md" ||
    trimmed === "**/PROJECT.md"
  );
}

/** True when `.gitignore` already has an entry that ignores root PROJECT.md. */
export function gitignoreHasProjectMemoryEntry(content: string): boolean {
  return content.split(/\r?\n/).some(lineIgnoresProjectMd);
}

/** True when a gitignore line covers the whole docs/ directory. */
function lineIgnoresDocsDir(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  return (
    trimmed === `${PROJECT_DOCS_DIR}/` ||
    trimmed === `/${PROJECT_DOCS_DIR}/` ||
    trimmed === PROJECT_DOCS_DIR ||
    trimmed === `/${PROJECT_DOCS_DIR}`
  );
}

function lineIgnoresDocFile(line: string, doc: ProjectDocId): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  const rel = `${PROJECT_DOCS_DIR}/${PROJECT_DOC_FILENAMES[doc]}`;
  return trimmed === rel || trimmed === `/${rel}`;
}

function docFileRel(doc: ProjectDocId): string {
  return `${PROJECT_DOCS_DIR}/${PROJECT_DOC_FILENAMES[doc]}`;
}

/**
 * Rewrite `.gitignore` content so the five docs/ memory files are trackable.
 * - explicit per-file ignore lines for the docs are dropped;
 * - a whole-dir `docs/` ignore becomes `docs/*` + `!`-negations for the five
 *   files (everything else under docs/ stays ignored).
 * Returns null when nothing needs to change.
 */
export function makeDocsTrackableInGitignore(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const docIds = Object.keys(PROJECT_DOC_FILENAMES) as ProjectDocId[];
  let changed = false;
  const out: string[] = [];

  for (const line of lines) {
    if (lineIgnoresDocsDir(line)) {
      out.push(`${PROJECT_DOCS_DIR}/*`);
      for (const doc of docIds) out.push(`!${docFileRel(doc)}`);
      changed = true;
      continue;
    }
    if (docIds.some((doc) => lineIgnoresDocFile(line, doc))) {
      changed = true; // drop the stale ignore line
      continue;
    }
    out.push(line);
  }

  return changed ? out.join("\n") : null;
}

/**
 * Ensure the five docs/ memory files are trackable (docs memory is COMMITTED,
 * per project convention). Stale ignore entries are stripped. Best-effort:
 * never throws.
 */
export async function ensureProjectDocFilesTrackable(
  workspacePath: string,
): Promise<void> {
  const root = workspacePath.trim();
  if (!root) return;

  try {
    const gitignorePath = join(root, ".gitignore");
    let existing = "";
    try {
      existing = await readFile(gitignorePath, "utf8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") throw err;
    }

    const next = makeDocsTrackableInGitignore(existing);
    if (next !== null) {
      await writeFile(gitignorePath, next, "utf8");
      agentLogInfo("project_memory.docs_gitignore_trackable", {
        workspacePath: root,
      });
    }
  } catch (err) {
    agentLogWarn("project_memory.docs_gitignore_failed", {
      workspacePath: root,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Ensure workspace-root PROJECT.md is gitignored and not tracked.
 * Best-effort: never throws (project-memory writes must still succeed).
 */
export async function ensureProjectMemoryGitignored(
  workspacePath: string,
): Promise<void> {
  const root = workspacePath.trim();
  if (!root) return;

  try {
    const gitignorePath = join(root, ".gitignore");
    let existing = "";
    try {
      existing = await readFile(gitignorePath, "utf8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") throw err;
    }

    if (!gitignoreHasProjectMemoryEntry(existing)) {
      let next = existing;
      if (next.length > 0 && !next.endsWith("\n")) next += "\n";
      if (next.length > 0) next += "\n";
      next += `${GITIGNORE_COMMENT}\n${PROJECT_MEMORY_FILENAME}\n`;
      await writeFile(gitignorePath, next, "utf8");
      agentLogInfo("project_memory.gitignore_appended", {
        workspacePath: root,
      });
    }

    await untrackIfTracked(root, PROJECT_MEMORY_FILENAME);
  } catch (err) {
    agentLogWarn("project_memory.gitignore_failed", {
      workspacePath: root,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function untrackIfTracked(root: string, relPath: string): Promise<void> {
  try {
    await execGit(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return;
  }

  const { stdout } = await execGit(root, ["ls-files", "--", relPath]);
  if (!stdout.trim()) return;

  await execGit(root, ["rm", "--cached", "-f", "--", relPath]);
  agentLogInfo("project_memory.git_untracked", {
    workspacePath: root,
    relPath,
  });
}
