/**
 * docs/ memory log files (WORKLOG / PITFALLS / HANDOFF / STYLE / DEPLOY).
 * WORKLOG and PITFALLS are prepend-only logs (newest first, entry/char caps);
 * HANDOFF / STYLE / DEPLOY are full-replacement documents.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import { ensureProjectDocFilesTrackable } from "./ensureGitignored.js";
import {
  PROJECT_DOCS_DIR,
  PROJECT_DOC_FILENAMES,
  PROJECT_DOC_RULES,
  PROJECT_DOC_TITLES,
  PROJECT_WORKLOG_MAX_ENTRIES,
  type ProjectDocId,
} from "./types.js";
import { extractDocEntries } from "./sections.js";

function normalizeWorkspacePath(workspacePath: string): string {
  return resolve(workspacePath.trim());
}

export type ProjectWorklogWriteListener = (workspacePath: string) => void;
const worklogListeners = new Set<ProjectWorklogWriteListener>();

/** Observe docs/WORKLOG.md content writes (entry appends and full replacements). Returns an unsubscribe. */
export function onProjectWorklogWritten(listener: ProjectWorklogWriteListener): () => void {
  worklogListeners.add(listener);
  return () => worklogListeners.delete(listener);
}

function notifyWorklogWritten(workspacePath: string): void {
  const key = normalizeWorkspacePath(workspacePath);
  for (const listener of worklogListeners) {
    try { listener(key); } catch (err) { console.warn("[project-docs] worklog listener failed", err); }
  }
}

export function projectDocFilePath(
  workspacePath: string,
  doc: ProjectDocId,
): string {
  return join(
    normalizeWorkspacePath(workspacePath),
    PROJECT_DOCS_DIR,
    PROJECT_DOC_FILENAMES[doc],
  );
}

/** Render the skeleton header (title + rule) for a docs file. */
export function projectDocHeader(doc: ProjectDocId): string {
  return `# ${PROJECT_DOC_TITLES[doc]}\n\n> ${PROJECT_DOC_RULES[doc]}\n`;
}

/** Load a docs file body ("" when missing / unreadable). */
export async function loadProjectDoc(
  workspacePath: string,
  doc: ProjectDocId,
): Promise<string> {
  const filePath = projectDocFilePath(workspacePath, doc);
  try {
    const text = await readFile(filePath, "utf8");
    return text.replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

async function persistDoc(
  workspacePath: string,
  doc: ProjectDocId,
  body: string,
): Promise<void> {
  const filePath = projectDocFilePath(workspacePath, doc);
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  await rename(temp, filePath);
}

/**
 * Split a docs body into (headerBlock, entriesBlock).
 * headerBlock = leading `# title` + `> rule` lines + surrounding blanks.
 */
function splitDocBody(body: string): { header: string; rest: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  // Title line (optional).
  if (i < lines.length && /^#\s+/.test(lines[i]!.trim())) i++;
  // Blank(s) then blockquote rule lines (optional).
  while (i < lines.length && lines[i]!.trim() === "") i++;
  while (i < lines.length && lines[i]!.trim().startsWith(">")) i++;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const header = lines.slice(0, i).join("\n").replace(/\s+$/u, "");
  const rest = lines.slice(i).join("\n").replace(/^\n+|\n+$/g, "");
  return { header, rest };
}

/**
 * Create any missing docs/ memory files with their skeleton headers.
 * Existing files are never overwritten. Also keeps them trackable.
 */
export async function ensureProjectDocsSkeleton(
  workspacePath: string,
): Promise<void> {
  const root = workspacePath.trim();
  if (!root) return;
  for (const doc of Object.keys(PROJECT_DOC_FILENAMES) as ProjectDocId[]) {
    const existing = await loadProjectDoc(root, doc);
    if (existing.length > 0) continue; // exists (even whitespace-only): never overwrite
    await persistDoc(root, doc, projectDocHeader(doc));
    agentLogInfo("project_memory.docs_skeleton_created", {
      workspacePath: root,
      doc,
    });
  }
  await ensureProjectDocFilesTrackable(root);
}

/**
 * Prepend entries (newest first) to a log docs file. Enforces the WORKLOG
 * hard entry cap by dropping the oldest overflow (mechanical, logged).
 */
export async function appendProjectDocEntries(
  workspacePath: string,
  doc: "worklog" | "pitfalls",
  entries: string[],
): Promise<void> {
  const cleaned = entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith("-") ? entry : `- ${entry}`));
  if (cleaned.length === 0) return;

  const root = workspacePath.trim();
  if (!root) throw new Error("workspacePath is required");

  const body = await loadProjectDoc(root, doc);
  const { header, rest } = splitDocBody(body);
  const existing = extractDocEntries(rest);
  const merged = [...cleaned, ...existing];

  const cap = doc === "worklog" ? PROJECT_WORKLOG_MAX_ENTRIES : Number.POSITIVE_INFINITY;
  const kept = merged.slice(0, cap);
  if (kept.length < merged.length) {
    agentLogWarn("project_memory.docs_entry_cap", {
      workspacePath: root,
      doc,
      dropped: merged.length - kept.length,
    });
  }

  const head = header || projectDocHeader(doc).trimEnd();
  await persistDoc(root, doc, `${head}\n\n${kept.join("\n")}\n`);
  if (doc === "worklog") notifyWorklogWritten(root);
  await ensureProjectDocFilesTrackable(root);
}

/**
 * Replace a full-replacement docs file body (any doc; used by the extract
 * flow for HANDOFF / STYLE / DEPLOY and for post-summarize write-backs).
 * The canonical `# Title` header is (re)asserted on top.
 */
export async function replaceProjectDocBody(
  workspacePath: string,
  doc: ProjectDocId,
  body: string,
): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) return;

  const root = workspacePath.trim();
  if (!root) throw new Error("workspacePath is required");

  const title = `# ${PROJECT_DOC_TITLES[doc]}`;
  const next = trimmed.startsWith("# ")
    ? trimmed
    : `${title}\n\n${trimmed}`;
  await persistDoc(root, doc, next);
  if (doc === "worklog") notifyWorklogWritten(root);
  await ensureProjectDocFilesTrackable(root);
}

/** Head excerpt of a docs file for prompt context. */
export async function readProjectDocHead(
  workspacePath: string,
  doc: ProjectDocId,
  maxChars: number,
): Promise<string> {
  const body = await loadProjectDoc(workspacePath, doc);
  if (!body.trim()) return "(empty)";
  if (body.length <= maxChars) return body.trim();
  return `${body.slice(0, maxChars).trimEnd()}\n…(truncated for context)`;
}
