/**
 * Files-pane preview operations shared by the desktop IPC handlers
 * (fs:readTextFile / fs:filterExistingFiles) and the remote bridge's
 * read-only actions. Single source of truth so both surfaces keep the
 * same size caps and binary detection.
 */
import { readFile, stat } from "node:fs/promises";

export const TEXT_PREVIEW_MAX_BYTES = 1_000_000;
export const EXISTING_FILES_MAX_PATHS = 200;

export type TextFilePreviewResult =
  | { ok: true; content: string }
  | { ok: false; message: string };

export async function readTextFilePreview(
  targetPath: string,
): Promise<TextFilePreviewResult> {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  try {
    const buf = await readFile(targetPath.trim());
    if (buf.length > TEXT_PREVIEW_MAX_BYTES) {
      return {
        ok: false,
        message: "File is too large to preview (max 1 MB).",
      };
    }
    if (buf.includes(0)) {
      return {
        ok: false,
        message: "Binary file — cannot preview as text.",
      };
    }
    return { ok: true, content: buf.toString("utf8") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

export async function filterExistingFilePaths(
  paths: unknown,
): Promise<string[]> {
  if (!Array.isArray(paths)) return [];
  const candidates = Array.from(
    new Set(
      paths.filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      ),
    ),
  ).slice(0, EXISTING_FILES_MAX_PATHS);
  const checked = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const info = await stat(candidate);
        return info.isFile() ? candidate : null;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((p): p is string => p !== null);
}
