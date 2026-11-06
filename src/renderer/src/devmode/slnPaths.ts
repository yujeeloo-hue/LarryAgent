/**
 * .sln path math for the Solution Outline (pure, renderer-safe).
 * .sln entries use backslash-separated paths relative to the solution file.
 */

/** Normalize backslashes and resolve `..` / `.` segments against the sln dir. */
export function resolveSlnRelative(slnPath: string, rel: string): string {
  const base = slnPath.replace(/\\/g, "/").split("/");
  base.pop(); // drop the .sln file name
  const parts = [...base];
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      // Clamp at the root: keep the leading "" of absolute paths.
      if (parts.length > 1 || parts[0] !== "") parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

export function baseNameOf(path: string): string {
  const segs = path.replace(/\\/g, "/").split("/");
  return segs[segs.length - 1] ?? path;
}

/**
 * Agent tool paths (write_file / patch args) may be workspace-relative or
 * absolute. Absolute (drive / UNC / POSIX-root) pass through unchanged;
 * relative join the workspace root. Null when relative and no root is known.
 */
export function resolveWorkspaceFilePath(
  rawPath: string,
  root: string | null,
): string | null {
  const normalized = rawPath.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  if (
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//") ||
    normalized.startsWith("/")
  ) {
    return normalized;
  }
  if (!root) return null;
  return `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/${normalized}`;
}

export function parentDirOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? normalized : normalized.slice(0, idx);
}

/**
 * UE puts its generated vcxproj at `<root>/Intermediate/ProjectFiles/*.vcxproj`
 * — the real project root (Source/, Config/, .uproject) is two levels up.
 * Returns null for regular project paths.
 */
export function ueProjectRootOf(projectPath: string): string | null {
  const dir = parentDirOf(projectPath);
  if (dir.toLowerCase().endsWith("/intermediate/projectfiles")) {
    return parentDirOf(parentDirOf(dir));
  }
  return null;
}

/** UBT names the engine's own project UE5 / UE4 / Engine / UnrealEngine. */
const UE_ENGINE_PROJECT_STEM = /^(ue\d*|engine|unrealengine)$/i;

/**
 * True for the engine's own UBT project. A game solution lists it alongside
 * the game's project — often under the *game's* `Intermediate/ProjectFiles`
 * — so ueProjectRootOf() would point it at the game root and the tree would
 * show game code. Callers substitute the resolved engine root instead.
 */
export function isUeEngineProjectPath(projectPath: string): boolean {
  if (ueProjectRootOf(projectPath) === null) return false;
  const stem = baseNameOf(projectPath).replace(/\.[^.]*$/, "");
  return UE_ENGINE_PROJECT_STEM.test(stem);
}

/** Parent with root semantics: "/a" → "/", "E:/a" → "E:/", "/" → null. */
function parentSegmentOf(dir: string): string | null {
  const idx = dir.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 2 && dir[1] === ":") return dir.slice(0, 3); // E:/a → E:/
  if (idx === 0) return "/"; // /a → /
  return dir.slice(0, idx);
}

function underAnchor(dir: string, anchor: string): boolean {
  if (dir === anchor) return true;
  return dir.startsWith(anchor.endsWith("/") ? anchor : `${anchor}/`);
}

/** Shallowest directory containing every input dir ("" → null-safe). */
export function commonAncestorDirOf(dirs: string[]): string | null {
  if (dirs.length === 0) return null;
  let anchor = dirs[0]!;
  for (const dir of dirs) {
    while (!underAnchor(dir, anchor)) {
      const parent = parentSegmentOf(anchor);
      if (parent === null || parent === anchor) break;
      anchor = parent;
    }
  }
  return anchor;
}
