/**
 * Map an editor file + line onto Chrome `Debugger.setBreakpointByUrl` locations.
 *
 * electron-vite serves the renderer from `src/renderer`, so Chromium sees
 * `http://localhost:5173/src/screens/foo.ts` rather than the workspace path
 * `src/renderer/src/screens/foo.ts`. Source maps often name only the basename.
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  debugPathFromUrl,
  debugPathsReferToSameFile,
  type SourceMapIndex,
} from "./sourceMap.js";

export type CdpBreakpointLocation = {
  url?: string;
  urlRegex?: string;
  lineNumber: number;
};

export type CdpScriptLike = {
  url: string;
  map: SourceMapIndex | null;
};

export function scriptUrlMatchesFile(
  scriptUrl: string,
  filePath: string,
): boolean {
  if (!scriptUrl || scriptUrl.startsWith("node:")) return false;
  if (scriptUrl.includes("node_modules")) return false;
  return debugPathsReferToSameFile(scriptUrl, filePath);
}

export function cdpBreakpointLocations(
  filePath: string,
  line: number,
  projectRoot: string,
  scripts: Iterable<CdpScriptLike>,
): CdpBreakpointLocation[] {
  const out: CdpBreakpointLocation[] = [];
  const seen = new Set<string>();
  const add = (loc: CdpBreakpointLocation): void => {
    const key = `${loc.url ?? ""}|${loc.urlRegex ?? ""}|${loc.lineNumber}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(loc);
  };

  let mapped = false;
  for (const script of scripts) {
    if (!script.url) continue;
    const urlMatch = scriptUrlMatchesFile(script.url, filePath);
    const generated = script.map?.generatedPositionFor(filePath, line);
    if (generated && (urlMatch || script.map?.containsOriginal(filePath))) {
      add({ url: script.url, lineNumber: generated.line });
      mapped = true;
      continue;
    }
    if (urlMatch) {
      add({ url: script.url, lineNumber: line - 1 });
      mapped = true;
    }
  }
  if (mapped) return out;

  add({ url: pathToFileURL(filePath).href, lineNumber: line - 1 });
  for (const pattern of urlRegexCandidates(filePath, projectRoot)) {
    add({ urlRegex: pattern, lineNumber: line - 1 });
  }
  return out;
}

export function urlRegexCandidates(filePath: string, projectRoot: string): string[] {
  const posix = filePath.replace(/\\/g, "/");
  const raw: string[] = [posix];
  if (/^[a-zA-Z]:\//.test(posix)) {
    raw.push(`/@fs/${posix}`);
  }
  const rel = relative(projectRoot, filePath).replace(/\\/g, "/");
  if (rel && !rel.startsWith("..")) {
    const parts = rel.split("/").filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) {
      raw.push(parts.slice(i).join("/"));
    }
  }
  const unique = [...new Set(raw.filter(Boolean))];
  return unique.map((value) => `${escapeRegExp(value)}(?:\\?|#|$)`);
}

export function candidateWorkspaceFiles(
  debugUrl: string,
  projectRoot: string,
): string[] {
  if (!debugUrl || /^(devtools|node|chrome-extension):/i.test(debugUrl)) {
    return [];
  }
  const stripped = debugPathFromUrl(debugUrl);
  if (!stripped) return [];
  if (/^[a-zA-Z]:\//.test(stripped)) {
    return uniquePaths([stripped.replace(/\//g, pathSepHint(projectRoot))]);
  }
  if (stripped.startsWith("/") && !stripped.startsWith("/src/")) {
    return uniquePaths([stripped]);
  }
  const rel = stripped.replace(/^\//, "");
  return uniquePaths([
    join(projectRoot, rel),
    join(projectRoot, "src/renderer", rel),
    join(projectRoot, "src", rel),
  ]);
}

export function resolveWorkspacePath(
  source: string,
  scriptUrl: string,
  projectRoot: string,
): string | null {
  const resolved = resolveAgainstScript(source, scriptUrl);
  const urls = [resolved, source, scriptUrl].filter(Boolean);
  const files: string[] = [];
  for (const url of urls) {
    if (/^file:/i.test(url)) {
      try {
        files.push(fileURLToPath(url));
      } catch {
        /* ignore */
      }
    }
    files.push(...candidateWorkspaceFiles(url, projectRoot));
  }
  const unique = uniquePaths(files);
  const existing = unique.find((file) => existsSync(file));
  if (existing) return existing;
  const vite = unique.find((file) =>
    file.replace(/\\/g, "/").includes("/src/renderer/"),
  );
  return vite ?? unique[0] ?? null;
}

function resolveAgainstScript(source: string, scriptUrl: string): string {
  if (!source) return scriptUrl;
  if (/^[a-z]+:\/\//i.test(source) || /^[a-zA-Z]:[\\/]/.test(source) || source.startsWith("/")) {
    return source;
  }
  if (!scriptUrl) return source;
  try {
    return new URL(source, scriptUrl).href;
  } catch {
    return source;
  }
}

function pathSepHint(projectRoot: string): string {
  return projectRoot.includes("\\") ? "\\" : "/";
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (!path || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
