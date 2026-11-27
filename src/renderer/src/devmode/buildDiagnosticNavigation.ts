import type { BuildDiagnostic } from "./buildDiagnostics.js";
import { resolveWorkspaceFilePath } from "./slnPaths.js";

type NavigationDeps = {
  getWorkspacePath: () => string | null;
  filterExistingFiles: (paths: string[]) => Promise<string[]>;
  resolveSourcePath: (root: string, path: string) => Promise<string | null>;
  revealFileLine: (path: string, line: number, column: number) => Promise<void>;
};

export async function revealBuildDiagnostic(
  item: BuildDiagnostic,
  workspacePath: string,
  deps: NavigationDeps,
): Promise<void> {
  if (!item.path || !item.line || deps.getWorkspacePath() !== workspacePath) return;
  const direct = resolveWorkspaceFilePath(item.path, workspacePath)!;
  let path = direct;
  try {
    const existing = await deps.filterExistingFiles([direct]);
    if (deps.getWorkspacePath() !== workspacePath) return;
    path = existing[0] ?? await deps.resolveSourcePath(workspacePath, item.path) ?? direct;
  } catch {
  }
  if (deps.getWorkspacePath() !== workspacePath) return;
  await deps.revealFileLine(path, item.line, item.column ?? 1);
}
