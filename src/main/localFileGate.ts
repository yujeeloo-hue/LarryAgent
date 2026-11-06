import { extname, isAbsolute, relative, resolve } from "node:path";

/**
 * Pure request gate for the jellybot-file protocol. No Electron imports —
 * the rules stay unit-testable under node:test; the protocol handler in
 * localFileProtocol.ts owns the Electron wiring.
 */

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const DEMO_HTML_EXTS = new Set([".html", ".htm"]);

/** Extensions the protocol serves to the renderer. */
export const LOCAL_FILE_PREVIEW_EXTS = new Set([
  ...IMAGE_EXTS,
  ".pdf",
  ...DEMO_HTML_EXTS,
]);

export function isDemoHtmlPath(path: string): boolean {
  return DEMO_HTML_EXTS.has(extname(path).toLowerCase());
}

/** Lexical containment with a proper boundary (no `/root-evil` prefix match). */
export function isPathUnderRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type LocalFileGateResult =
  | { allowed: true; filePath: string }
  | { allowed: false; status: 400 | 403 | 404; reason: string };

/**
 * Gate one request path.
 * Images/PDF keep the extension-only gate (historical behavior).
 * Demo HTML (.html/.htm) additionally requires the file to live under one of
 * `demoRoots` (active workspace root + os.tmpdir()) — defense in depth for
 * the present_demo iframe. Relative inputs 404 instead of silently
 * resolving against the main-process cwd.
 */
export function gateLocalFilePath(
  rawPath: string | null,
  demoRoots: readonly string[],
): LocalFileGateResult {
  if (!rawPath) {
    return { allowed: false, status: 400, reason: "Missing path" };
  }
  if (!isAbsolute(rawPath)) {
    return { allowed: false, status: 404, reason: "Not found" };
  }
  const filePath = resolve(rawPath);
  const ext = extname(filePath).toLowerCase();
  if (!LOCAL_FILE_PREVIEW_EXTS.has(ext)) {
    return { allowed: false, status: 403, reason: "Forbidden" };
  }
  if (DEMO_HTML_EXTS.has(ext)) {
    const underRoot = demoRoots.some(
      (root) => root.trim() !== "" && isPathUnderRoot(filePath, root),
    );
    if (!underRoot) {
      return { allowed: false, status: 403, reason: "Forbidden" };
    }
  }
  return { allowed: true, filePath };
}
