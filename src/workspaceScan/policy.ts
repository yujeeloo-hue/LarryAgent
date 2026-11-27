export const ALWAYS_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".jellybot",
]);

export const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  "bin",
  "obj",
  "packages",
  "testresults",
  "dist",
  "out",
  "release",
  "tmp",
  "coverage",
  "venv",
  "__pycache__",
]);

export const UNREAL_SKIP_DIRS: ReadonlySet<string> = new Set([
  "content",
  "intermediate",
  "binaries",
  "deriveddatacache",
  "saved",
  "cooked",
  "staging",
  "documentation",
  "featurepacks",
  "samples",
  "extras",
  "templates",
  "__externalactors__",
  "__externalobjects__",
]);

export const UNREAL_ENGINE_TOP_DIRS: readonly string[] = [
  "Source",
  "Plugins",
  "Config",
  "Shaders",
  "Programs",
];

export const IGNORED_FILE_NAMES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

export const TEMP_FILE_SUFFIX = ".jbt.tmp";

export const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  "uasset", "umap", "uexp", "ubulk", "ufont", "upk",
  "png", "jpg", "jpeg", "gif", "bmp", "tga", "psd", "exr", "hdr", "dds",
  "ktx", "webp", "svg",
  "wav", "mp3", "ogg", "flac", "aac", "wem", "bnk",
  "fbx", "obj", "abc", "usd", "usda", "usdc", "blend", "max", "ma", "mb",
  "dll", "exe", "pdb", "lib", "so", "dylib", "bin", "o",
  "ttf", "otf", "woff", "woff2",
  "mp4", "mov", "avi", "webm",
  "zip", "7z", "rar", "gz", "tar", "pak", "ucas", "utoc",
  "pdf", "db", "sqlite", "mdb", "dat", "log",
]);

const PRIORITY_DIRS: ReadonlySet<string> = new Set([
  "source", "src", "plugins", "config", "include", "inc", "private",
  "public", "classes", "shader", "shaders", "scripts",
]);

const DEPRIORITIZED_DIRS: ReadonlySet<string> = new Set([
  "content", "intermediate", "binaries", "deriveddatacache", "saved",
  "build", "builds", "docs", "doc", "thirdparty", "extern", "movies",
  "textures", "dcc", "art", "rawcontent", "cooked", "staging",
]);

export type ScanMode = "git" | "walk";

export type ScanRules = {
  mode: ScanMode;
  unreal: boolean;
};

export const SCAN_RANK_SOURCE = 0;
export const SCAN_RANK_NEUTRAL = 1;
export const SCAN_RANK_ASSET = 2;
export type ScanRank = 0 | 1 | 2;

export function isSkippedDir(name: string, rules: ScanRules): boolean {
  const lower = name.toLowerCase();
  if (ALWAYS_SKIP_DIRS.has(lower)) return true;
  if (rules.unreal && UNREAL_SKIP_DIRS.has(lower)) return true;
  if (rules.mode === "walk") {
    if (name.startsWith(".")) return true;
    if (WALK_SKIP_DIRS.has(lower)) return true;
  }
  return false;
}

export function isIgnoredFileName(name: string): boolean {
  return IGNORED_FILE_NAMES.has(name) || name.endsWith(TEMP_FILE_SUFFIX);
}

export function isSkippedRelPath(rel: string, rules: ScanRules): boolean {
  const segments = rel.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;
  for (let i = 0; i < segments.length - 1; i++) {
    if (isSkippedDir(segments[i]!, rules)) return true;
  }
  return isIgnoredFileName(segments[segments.length - 1]!);
}

export function fileExtension(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = name.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function isAssetPath(name: string): boolean {
  return ASSET_EXTENSIONS.has(fileExtension(name));
}

export function dirRank(name: string): ScanRank {
  const lower = name.toLowerCase();
  if (PRIORITY_DIRS.has(lower)) return SCAN_RANK_SOURCE;
  if (DEPRIORITIZED_DIRS.has(lower)) return SCAN_RANK_ASSET;
  return SCAN_RANK_NEUTRAL;
}

export function relPathRank(rel: string, base: ScanRank = SCAN_RANK_NEUTRAL): ScanRank {
  let rank: ScanRank = base;
  const segments = rel.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const next = dirRank(segments[i]!);
    if (next > rank) rank = next;
  }
  return rank;
}

export function ripgrepExcludeGlobs(rules: ScanRules): string[] {
  const dirs = new Set<string>(ALWAYS_SKIP_DIRS);
  if (rules.unreal) for (const dir of UNREAL_SKIP_DIRS) dirs.add(dir);
  if (rules.mode === "walk") for (const dir of WALK_SKIP_DIRS) dirs.add(dir);
  const globs = [...dirs].sort().map((dir) => `!**/${caseInsensitiveGlob(dir)}/**`);
  for (const name of [...IGNORED_FILE_NAMES].sort()) globs.push(`!**/${name}`);
  globs.push(`!**/*${TEMP_FILE_SUFFIX}`);
  return globs;
}

function caseInsensitiveGlob(name: string): string {
  let out = "";
  for (const ch of name) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    out += lower === upper ? ch : `[${lower}${upper}]`;
  }
  return out;
}
