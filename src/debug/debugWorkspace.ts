function workspaceKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return /^(?:[a-z]:|\/\/)/i.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

export function sameDebugWorkspace(a: string, b: string): boolean {
  return workspaceKey(a) === workspaceKey(b);
}

export function debugBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = normalized.lastIndexOf("/");
  return cut >= 0 ? normalized.slice(cut + 1) : normalized;
}

export function debugDisplayPath(workspacePath: string, file: string): string {
  if (!workspacePath) return file;
  const base = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = file.replace(/\\/g, "/");
  if (!base) return file;
  const caseInsensitive = /^(?:[a-z]:|\/\/)/i.test(base);
  const prefixMatch = caseInsensitive
    ? target.toLowerCase().startsWith(`${base.toLowerCase()}/`)
    : target.startsWith(`${base}/`);
  return prefixMatch ? target.slice(base.length + 1) : file;
}
