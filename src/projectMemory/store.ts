import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  PROJECT_MEMORY_FILENAME,
  type ProjectMemorySectionId,
  type ProjectMemorySnapshot,
} from "./types.js";
import { applySectionUpdate, extractDocEntries, formatProjectBody, parseProjectSections, restoreDocsGuideSection, synthesizeRecentSection } from "./sections.js";
import { loadProjectDoc } from "./docsStore.js";
import { ensureProjectMemoryGitignored } from "./ensureGitignored.js";

type CacheEntry = {
  body: string;
  updatedAt: number;
  empty: boolean;
};

const cache = new Map<string, CacheEntry>();

type ProjectMemoryWriteListener = (workspacePath: string, body: string) => void;
const writeListeners = new Set<ProjectMemoryWriteListener>();

export function onProjectMemoryWritten(listener: ProjectMemoryWriteListener): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

function normalizeWorkspacePath(workspacePath: string): string {
  return resolve(workspacePath.trim());
}

export function projectMemoryFilePath(workspacePath: string): string {
  return join(normalizeWorkspacePath(workspacePath), PROJECT_MEMORY_FILENAME);
}

function emptySnapshot(workspacePath: string): ProjectMemorySnapshot {
  const root = workspacePath.trim()
    ? normalizeWorkspacePath(workspacePath)
    : "";
  return {
    workspacePath: root,
    body: "",
    updatedAt: 0,
    empty: true,
    filePath: root ? projectMemoryFilePath(root) : PROJECT_MEMORY_FILENAME,
  };
}

function toSnapshot(
  workspacePath: string,
  entry: CacheEntry,
): ProjectMemorySnapshot {
  const root = normalizeWorkspacePath(workspacePath);
  const body = entry.body;
  return {
    workspacePath: root,
    body,
    updatedAt: entry.updatedAt,
    empty: body.trim().length === 0,
    filePath: projectMemoryFilePath(root),
  };
}

export function invalidateProjectMemoryCache(workspacePath: string): void {
  const root = workspacePath.trim();
  if (!root) return;
  cache.delete(normalizeWorkspacePath(root));
}

export async function loadProjectMemory(
  workspacePath: string,
): Promise<ProjectMemorySnapshot> {
  const root = workspacePath.trim();
  if (!root) return emptySnapshot("");

  const key = normalizeWorkspacePath(root);
  const cached = cache.get(key);
  if (cached) return toSnapshot(key, cached);

  const filePath = projectMemoryFilePath(key);
  try {
    const text = await readFile(filePath, "utf8");
    const body = text.replace(/^\uFEFF/, "");
    const entry: CacheEntry = {
      body,
      updatedAt: Date.now(),
      empty: body.trim().length === 0,
    };
    cache.set(key, entry);
    return toSnapshot(key, entry);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") {
    }
    const entry: CacheEntry = { body: "", updatedAt: 0, empty: true };
    cache.set(key, entry);
    return toSnapshot(key, entry);
  }
}

export function getProjectMemoryCached(
  workspacePath: string,
): ProjectMemorySnapshot {
  const root = workspacePath.trim();
  if (!root) return emptySnapshot("");
  const key = normalizeWorkspacePath(root);
  const cached = cache.get(key);
  if (!cached) return emptySnapshot(key);
  return toSnapshot(key, cached);
}

async function persist(
  workspacePath: string,
  body: string,
): Promise<ProjectMemorySnapshot> {
  const key = normalizeWorkspacePath(workspacePath);
  const filePath = projectMemoryFilePath(key);
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  await rename(temp, filePath);
  const entry: CacheEntry = {
    body,
    updatedAt: Date.now(),
    empty: body.trim().length === 0,
  };
  cache.set(key, entry);
  await ensureProjectMemoryGitignored(key);
  for (const listener of writeListeners) {
    try { listener(key, body); } catch (err) { console.warn("[project-memory] write listener failed", err); }
  }
  return toSnapshot(key, entry);
}

export async function setProjectMemoryBody(
  workspacePath: string,
  body: string,
): Promise<ProjectMemorySnapshot> {
  const root = workspacePath.trim();
  if (!root) {
    throw new Error("workspacePath is required");
  }
  return persist(root, body.trim());
}

async function synthesizeRecentInto(
  workspacePath: string,
  body: string,
): Promise<string> {
  const [worklog, handoff, pitfalls] = await Promise.all([
    loadProjectDoc(workspacePath, "worklog"),
    loadProjectDoc(workspacePath, "handoff"),
    loadProjectDoc(workspacePath, "pitfalls"),
  ]);
  const hasAny = [worklog, handoff, pitfalls].some(
    (b) => extractDocEntries(b).length > 0,
  );
  if (!hasAny) return body;
  const parsed = parseProjectSections(body);
  parsed.sections.recent = synthesizeRecentSection({
    worklogBody: worklog,
    handoffBody: handoff,
    pitfallsBody: pitfalls,
  });
  return formatProjectBody(parsed);
}

export async function composeProjectMemoryWrite(
  workspacePath: string,
  content: string,
  mode: "merge" | "replace" = "merge",
  section?: ProjectMemorySectionId | null,
): Promise<{ previous: ProjectMemorySnapshot; nextBody: string } | null> {
  const root = workspacePath.trim();
  if (!root) {
    throw new Error("workspacePath is required");
  }

  const current = await loadProjectMemory(root);
  const trimmed = content.trim();
  if (!trimmed && mode === "merge") {
    return null;
  }

  let nextBody: string;
  if (section) {
    const base = current.empty ? "# Project\n" : current.body;
    const updated = applySectionUpdate(base, section, trimmed, mode);
    nextBody = await synthesizeRecentInto(root, updated);
  } else if (mode === "replace") {
    nextBody = trimmed;
  } else if (current.empty) {
    nextBody = trimmed;
  } else {
    nextBody = `${current.body.trim()}\n\n${trimmed}`;
  }

  nextBody = restoreDocsGuideSection(nextBody);

  return { previous: current, nextBody };
}

export async function writeProjectMemory(
  workspacePath: string,
  content: string,
  mode: "merge" | "replace" = "merge",
  section?: ProjectMemorySectionId | null,
): Promise<ProjectMemorySnapshot> {
  const composed = await composeProjectMemoryWrite(
    workspacePath,
    content,
    mode,
    section,
  );
  if (!composed) {
    return loadProjectMemory(workspacePath);
  }
  return persist(workspacePath, composed.nextBody);
}

export async function clearProjectMemory(
  workspacePath: string,
): Promise<ProjectMemorySnapshot> {
  const root = workspacePath.trim();
  if (!root) {
    throw new Error("workspacePath is required");
  }
  const key = normalizeWorkspacePath(root);
  const filePath = projectMemoryFilePath(key);
  try {
    await unlink(filePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") throw err;
  }
  const entry: CacheEntry = { body: "", updatedAt: Date.now(), empty: true };
  cache.set(key, entry);
  return toSnapshot(key, entry);
}

