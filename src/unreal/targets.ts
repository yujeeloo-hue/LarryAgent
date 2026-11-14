/**
 * Discover Unreal `*Target.cs` files under the game `Source/` tree.
 */
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export type UnrealTargetType =
  | "Editor"
  | "Game"
  | "Client"
  | "Server"
  | "Program"
  | "unknown";

export type UnrealTargetInfo = {
  /** UBT target name = filename without `.Target.cs`. */
  name: string;
  path: string;
  type: UnrealTargetType;
};

const SKIP_DIRS = new Set([
  "intermediate",
  "binaries",
  "saved",
  "content",
  "deriveddatacache",
  "node_modules",
  ".git",
  ".svn",
]);

const TYPE_RE = /\bType\s*=\s*TargetType\.(\w+)/;
const TARGET_FILE_RE = /\.Target\.cs$/i;

function classifyType(raw: string | undefined, fileName: string): UnrealTargetType {
  const t = raw ?? "";
  if (t === "Editor" || t === "Game" || t === "Client" || t === "Server" || t === "Program") {
    return t;
  }
  if (/Editor\.Target\.cs$/i.test(fileName)) return "Editor";
  if (/Server\.Target\.cs$/i.test(fileName)) return "Server";
  if (/Client\.Target\.cs$/i.test(fileName)) return "Client";
  return "unknown";
}

function walkTargetFiles(dir: string, depth: number, acc: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      walkTargetFiles(join(dir, e.name), depth + 1, acc);
      continue;
    }
    if (e.isFile() && TARGET_FILE_RE.test(e.name)) {
      acc.push(join(dir, e.name));
    }
  }
}

/** Target name from `NFEditor.Target.cs` → `NFEditor`. */
export function targetNameFromFile(filePath: string): string {
  return basename(filePath).replace(/\.Target\.cs$/i, "");
}

export function parseTargetCs(filePath: string, text: string): UnrealTargetInfo {
  const m = TYPE_RE.exec(text);
  return {
    name: targetNameFromFile(filePath),
    path: filePath,
    type: classifyType(m?.[1], basename(filePath)),
  };
}

export async function listUnrealTargets(projectRoot: string): Promise<UnrealTargetInfo[]> {
  const source = join(projectRoot, "Source");
  const files: string[] = [];
  walkTargetFiles(source, 0, files);
  const out: UnrealTargetInfo[] = [];
  for (const file of files) {
    try {
      const text = await readFile(file, "utf8");
      out.push(parseTargetCs(file, text));
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

/**
 * Prefer `{uprojectBase}Editor`, then any Editor that is not UnrealEditor,
 * then UnrealEditor.
 */
export function pickEditorTarget(
  targets: readonly UnrealTargetInfo[],
  uprojectBase: string,
): UnrealTargetInfo | null {
  const editors = targets.filter((t) => t.type === "Editor");
  if (editors.length === 0) return null;
  const want = `${uprojectBase}Editor`.toLowerCase();
  const exact = editors.find((t) => t.name.toLowerCase() === want);
  if (exact) return exact;
  const named = editors.find((t) => t.name.toLowerCase() !== "unrealeditor");
  return named ?? editors[0] ?? null;
}
