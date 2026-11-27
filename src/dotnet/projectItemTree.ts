
export interface ProjectFileNode {
  path: string;
  name: string;
  isDir: boolean;
  children: ProjectFileNode[];
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? path : path.slice(0, idx);
}

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
    if (!p.startsWith(prefix)) continue;
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
