
export function resolveSlnRelative(slnPath: string, rel: string): string {
  const absolute = rel.replace(/\\/g, "/");
  if (/^(?:[A-Za-z]:\/|\/)/.test(absolute)) return absolute;
  const base = slnPath.replace(/\\/g, "/").split("/");
  base.pop();
  const parts = [...base];
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
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

export function ueProjectRootOf(projectPath: string): string | null {
  const dir = parentDirOf(projectPath);
  if (dir.toLowerCase().endsWith("/intermediate/projectfiles")) {
    return parentDirOf(parentDirOf(dir));
  }
  return null;
}

const UE_ENGINE_PROJECT_STEM = /^(ue\d*|engine|unrealengine)$/i;

export function isUeEngineProjectPath(projectPath: string): boolean {
  if (ueProjectRootOf(projectPath) === null) return false;
  const stem = baseNameOf(projectPath).replace(/\.[^.]*$/, "");
  return UE_ENGINE_PROJECT_STEM.test(stem);
}

function parentSegmentOf(dir: string): string | null {
  const idx = dir.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 2 && dir[1] === ":") return dir.slice(0, 3);
  if (idx === 0) return "/";
  return dir.slice(0, idx);
}

function underAnchor(dir: string, anchor: string): boolean {
  if (dir === anchor) return true;
  return dir.startsWith(anchor.endsWith("/") ? anchor : `${anchor}/`);
}

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
