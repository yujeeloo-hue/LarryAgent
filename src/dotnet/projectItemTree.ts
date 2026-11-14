/**
 * Pure project-item tree assembly (no fs, no DOM — safe in main & renderer).
 *
 * Takes the resolved absolute paths of a project file's items (see
 * msbuildProjectParser.ts + slnPaths.ts) and the project's root directory,
 * and nests them like the VS Solution Explorer: directories first (each
 * localeCompare-sorted), then files.
 *
 * Attachment rule — every directory chain must bottom out at `projectDir`:
 * direct children of `projectDir` attach to the returned root list, deeper
 * dirs to their parent dir node. Paths outside `projectDir` are dropped.
 */

export interface ProjectFileNode {
  /** Absolute path, forward slashes. */
  path: string;
  name: string;
  isDir: boolean;
  /** Dir nodes only; sorted dirs-first per level. */
  children: ProjectFileNode[];
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? path : path.slice(0, idx);
}

/**
 * Children of `projectDir` as a nested tree, or null when nothing remains.
 * `projectDir` itself must be a normalized absolute dir without trailing
 * slash ("" is rejected — no anchor to build against).
 */
export function buildProjectFileTree(
  projectDir: string,
  paths: string[],
): ProjectFileNode[] | null {
  if (!projectDir) return null;
  const prefix = projectDir.endsWith("/")
    ? projectDir
    : `${projectDir}/`;

  const dirs = new Map<string, ProjectFileNode>();
  const root: ProjectFileNode = {
    path: projectDir,
    name: "",
    isDir: true,
    children: [],
  };
  dirs.set(projectDir, root);

  const ensureDir = (dir: string): ProjectFileNode => {
    const existing = dirs.get(dir);
    if (existing) return existing;
    const created: ProjectFileNode = {
      path: dir,
      name: dir.slice(dir.lastIndexOf("/") + 1),
      isDir: true,
      children: [],
    };
    dirs.set(dir, created);
    ensureDir(parentOf(dir)).children.push(created);
    return created;
  };

  for (const p of paths) {
    if (p === projectDir) continue;
    if (!p.startsWith(prefix)) continue; // resolved outside the project root
    const idx = p.lastIndexOf("/");
    const name = p.slice(idx + 1);
    if (!name) continue;
    const parent = idx <= 0 ? projectDir : p.slice(0, idx);
    const file: ProjectFileNode = { path: p, name, isDir: false, children: [] };
    if (parent === projectDir) root.children.push(file);
    else ensureDir(parent).children.push(file);
  }

  const sortLevel = (nodes: ProjectFileNode[]): void => {
    if (nodes.length < 2) return;
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortLevel(n.children);
  };
  sortLevel(root.children);

  return root.children.length > 0 ? root.children : null;
}
