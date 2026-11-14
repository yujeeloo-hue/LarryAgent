/**
 * Turn-start workspace snapshot: a compact, gitignore-aware picture of the
 * repository so the model can target its first searches instead of
 * rediscovering the layout with list_dir every turn.
 *
 * Sent as part of the wire-only trailing note (after the conversation), so
 * it never perturbs the cached system prefix / transcript; built once per
 * turn and stable across that turn's model iterations.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execGit } from "../git/execGit.js";
import { listCandidateFiles } from "../tools/workspaceFiles.js";

export type EditorContextInput = {
  activeFile?: string | null;
  openFiles?: readonly string[];
};

export type RepoSnapshotInput = {
  workspacePath: string;
  editor?: EditorContextInput | null;
  /** Overall budget; the snapshot is skipped (null) when exceeded. */
  timeoutMs?: number;
  now?: number;
};

const DEFAULT_TIMEOUT_MS = 2_000;
const GIT_TIMEOUT_MS = 1_500;
const MAX_LISTED_FILES = 50_000;
const MAX_TOP_DIRS = 14;
const MAX_CHILD_DIRS = 8;
const MAX_TOP_FILES = 10;
const MAX_STATUS_LINES = 20;
const MAX_COMMITS = 5;
const MAX_RECENT_FILES = 10;
const MAX_EDITOR_FILES = 12;
/** Non-git roots: mtime candidates are capped (stat is the slow part). */
const MAX_WALK_STAT_CANDIDATES = 5_000;
const STAT_CONCURRENCY = 32;
const MAX_SNAPSHOT_CHARS = 4_000;

export const REPO_SNAPSHOT_HEADER =
  "[Workspace snapshot — captured when this turn started; paths are relative to Root; re-check with tools after edits]";

type DirNode = { files: number; children: Map<string, DirNode> };

function newDir(): DirNode {
  return { files: 0, children: new Map() };
}

function totalFiles(node: DirNode): number {
  let n = node.files;
  for (const child of node.children.values()) n += totalFiles(child);
  return n;
}

function buildTree(paths: readonly string[]): { root: DirNode; topFiles: string[] } {
  const root = newDir();
  const topFiles: string[] = [];
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    if (segments.length === 1) {
      topFiles.push(segments[0]!);
      root.files++;
      continue;
    }
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.children.get(segment);
      if (!next) {
        next = newDir();
        node.children.set(segment, next);
      }
      node = next;
    }
    node.files++;
  }
  return { root, topFiles };
}

function sortedChildren(node: DirNode): Array<[string, DirNode, number]> {
  return [...node.children.entries()]
    .map(([name, child]) => [name, child, totalFiles(child)] as [string, DirNode, number])
    .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
}

export function renderLayout(paths: readonly string[], truncated: boolean): string[] {
  const { root, topFiles } = buildTree(paths);
  const lines: string[] = [];
  const top = sortedChildren(root);
  const plus = truncated ? "+" : "";
  for (const [name, child, count] of top.slice(0, MAX_TOP_DIRS)) {
    lines.push(`  ${name}/ (${count}${plus})`);
    const kids = sortedChildren(child);
    if (kids.length > 0) {
      const shown = kids
        .slice(0, MAX_CHILD_DIRS)
        .map(([kid, , kidCount]) => `${kid}/ (${kidCount})`);
      const more = kids.length > MAX_CHILD_DIRS ? ` · +${kids.length - MAX_CHILD_DIRS} more` : "";
      lines.push(`    ${shown.join(" · ")}${more}`);
    }
  }
  if (top.length > MAX_TOP_DIRS) {
    lines.push(`  … +${top.length - MAX_TOP_DIRS} more top-level dirs`);
  }
  if (topFiles.length > 0) {
    const files = topFiles.slice().sort((a, b) => a.localeCompare(b));
    const more = files.length > MAX_TOP_FILES ? ` · +${files.length - MAX_TOP_FILES} more` : "";
    lines.push(`  ${files.slice(0, MAX_TOP_FILES).join(" · ")}${more}`);
  }
  return lines;
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execGit(root, args, { timeoutMs: GIT_TIMEOUT_MS });
    return stdout;
  } catch {
    return null;
  }
}

function nonEmptyLines(text: string | null): string[] {
  return (text ?? "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

/** `git status --short` row → path (rename rows keep the new path). */
function statusPath(row: string): string {
  const body = row.slice(3).trim();
  const arrow = body.lastIndexOf(" -> ");
  const raw = arrow >= 0 ? body.slice(arrow + 4) : body;
  return raw.replace(/^"(.*)"$/, "$1");
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function toRelativeInside(root: string, path: string): string | null {
  if (!path || !isAbsolute(path)) return null;
  const rel = relative(root, resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Editor tabs inside the workspace, active first, de-duplicated. */
export function editorFilesInside(
  root: string,
  editor: EditorContextInput | null | undefined,
): { active: string | null; open: string[] } {
  const active =
    typeof editor?.activeFile === "string" ? toRelativeInside(root, editor.activeFile) : null;
  const seen = new Set<string>(active ? [active] : []);
  const open: string[] = [];
  const openFiles = Array.isArray(editor?.openFiles) ? editor.openFiles.slice(0, 200) : [];
  for (const path of openFiles) {
    if (typeof path !== "string") continue;
    const rel = toRelativeInside(root, path);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    open.push(rel);
  }
  return { active, open };
}

async function newestFiles(
  root: string,
  relPaths: readonly string[],
  now: number,
  signal: AbortSignal,
): Promise<string[]> {
  const unique = [...new Set(relPaths)];
  const stamped: Array<{ rel: string; mtimeMs: number }> = [];
  for (let i = 0; i < unique.length; i += STAT_CONCURRENCY) {
    if (signal.aborted) return [];
    const batch = unique.slice(i, i + STAT_CONCURRENCY);
    const stats = await Promise.all(
      batch.map(async (rel) => {
        try {
          const info = await stat(join(root, rel.split("/").join(sep)));
          return info.isFile() ? info.mtimeMs : null;
        } catch {
          return null;
        }
      }),
    );
    batch.forEach((rel, idx) => {
      const mtimeMs = stats[idx];
      if (typeof mtimeMs === "number") stamped.push({ rel, mtimeMs });
    });
  }
  return stamped
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_RECENT_FILES)
    .map((f) => `  ${f.rel} (${formatAge(now - f.mtimeMs)})`);
}

async function buildSnapshot(
  input: RepoSnapshotInput,
  signal: AbortSignal,
): Promise<string | null> {
  const root = resolve(input.workspacePath);
  try {
    if (!(await stat(root)).isDirectory()) return null;
  } catch {
    return null;
  }
  const now = input.now ?? Date.now();

  const [listed, branch, status, commits, commitFiles] = await Promise.all([
    listCandidateFiles({ root, maxFiles: MAX_LISTED_FILES, signal }),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["status", "--short"]),
    git(root, ["log", `-${MAX_COMMITS}`, "--format=%h %cr %s"]),
    git(root, ["log", "-10", "--relative", "--name-only", "--format="]),
  ]);
  if (signal.aborted || listed.aborted) return null;

  const isGit = listed.source === "git" && branch !== null;
  const out: string[] = [REPO_SNAPSHOT_HEADER];
  const rootLabel = root.split(sep).join("/");
  out.push(
    isGit
      ? `Root: ${rootLabel} (git, branch ${branch!.trim() || "?"})`
      : `Root: ${rootLabel}${listed.source === "git" ? " (git)" : " (not a git repo)"}`,
  );

  const relPaths = listed.files.map((f) => f.relative);
  if (relPaths.length > 0) {
    out.push(
      `Layout (${relPaths.length}${listed.truncated ? "+" : ""} files, .gitignore respected; counts include subdirs):`,
    );
    out.push(...renderLayout(relPaths, listed.truncated));
  } else {
    out.push("Layout: (empty)");
  }

  const statusRows = nonEmptyLines(status);
  if (status !== null) {
    if (statusRows.length === 0) {
      out.push("Git status: clean");
    } else {
      out.push(`Git status (${statusRows.length} changed):`);
      out.push(...statusRows.slice(0, MAX_STATUS_LINES).map((r) => `  ${r}`));
      if (statusRows.length > MAX_STATUS_LINES) {
        out.push(`  … +${statusRows.length - MAX_STATUS_LINES} more`);
      }
    }
  }

  const commitRows = nonEmptyLines(commits);
  if (commitRows.length > 0) {
    out.push("Recent commits:");
    out.push(...commitRows.map((r) => `  ${r}`));
  }

  const recentCandidates = isGit
    ? [...statusRows.map(statusPath).filter((p) => !p.endsWith("/")), ...nonEmptyLines(commitFiles)]
    : relPaths.slice(0, MAX_WALK_STAT_CANDIDATES);
  const recent = await newestFiles(root, recentCandidates, now, signal);
  if (signal.aborted) return null;
  if (recent.length > 0) {
    out.push(isGit ? "Recently modified (changed or recently committed):" : "Recently modified:");
    out.push(...recent);
  }

  const editor = editorFilesInside(root, input.editor);
  if (editor.active || editor.open.length > 0) {
    out.push("Open in editor:");
    if (editor.active) out.push(`  * ${editor.active} (active)`);
    const shown = editor.open.slice(0, MAX_EDITOR_FILES - (editor.active ? 1 : 0));
    out.push(...shown.map((p) => `  ${p}`));
    const hidden = editor.open.length - shown.length;
    if (hidden > 0) out.push(`  … +${hidden} more`);
  }

  let text = out.join("\n");
  if (text.length > MAX_SNAPSHOT_CHARS) {
    text = `${text.slice(0, MAX_SNAPSHOT_CHARS)}\n… (snapshot truncated)`;
  }
  return text;
}

/**
 * Build the snapshot, or null when the workspace is missing or the budget
 * runs out (the turn must never wait on a slow disk / huge tree).
 */
export async function buildRepoSnapshot(
  input: RepoSnapshotInput,
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveTimeout(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      buildSnapshot(input, controller.signal).catch(() => null),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
