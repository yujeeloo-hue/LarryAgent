import { isSymbolIndexablePath } from "../../renderer/src/devmode/cppSymbolIndex.js";
import { scanWorkspaceFiles } from "../../workspaceScan/scanFiles.js";
import { normalizeSymbolPath } from "./paths.js";

export async function enumerateCppFiles(
  root: string,
  shouldStop?: () => boolean,
): Promise<string[]> {
  const out: string[] = [];
  await scanWorkspaceFiles({
    root: normalizeSymbolPath(root),
    include: isSymbolIndexablePath,
    ...(shouldStop ? { shouldStop } : {}),
    onFile: (file) => {
      out.push(normalizeSymbolPath(file.absolute));
    },
  });
  return out;
}
