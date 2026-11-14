/**
 * Extension → Monaco language id + tree/tab icon key registry for Dev Mode.
 * Pure data — no monaco import (the editor loads lazily on first toggle).
 * Language set mirrors File Reader's hljs registrations (codeHighlight.ts)
 * plus the 8 confirmed targets: C/C++/C#/JS/TS/CSS/HTML/Swift/Python (+XML).
 *
 * Monaco has no separate "c" tokenizer — .c/.h route to `cpp` (decided).
 */

export type FileIconKey =
  | "csharp"
  | "cpp"
  | "python"
  | "swift"
  | "typescript"
  | "javascript"
  | "css"
  | "html"
  | "xml"
  | "json"
  | "markdown"
  | "txt"
  | "text";

export type LanguageInfo = {
  /** Monaco language id; "plaintext" fallback keeps unknown extensions openable. */
  languageId: string;
  icon: FileIconKey;
};

const PLAINTEXT: LanguageInfo = { languageId: "plaintext", icon: "text" };

const EXT_LANGUAGE: Record<string, LanguageInfo> = {
  // C# (also Razor code-behind)
  cs: { languageId: "csharp", icon: "csharp" },
  // C / C++ — shared tokenizer (decided)
  c: { languageId: "cpp", icon: "cpp" },
  h: { languageId: "cpp", icon: "cpp" },
  cpp: { languageId: "cpp", icon: "cpp" },
  cc: { languageId: "cpp", icon: "cpp" },
  cxx: { languageId: "cpp", icon: "cpp" },
  cplusplus: { languageId: "cpp", icon: "cpp" },
  hpp: { languageId: "cpp", icon: "cpp" },
  hh: { languageId: "cpp", icon: "cpp" },
  hxx: { languageId: "cpp", icon: "cpp" },
  ino: { languageId: "cpp", icon: "cpp" },
  // Python
  py: { languageId: "python", icon: "python" },
  pyw: { languageId: "python", icon: "python" },
  pyi: { languageId: "python", icon: "python" },
  // Swift
  swift: { languageId: "swift", icon: "swift" },
  // JavaScript
  js: { languageId: "javascript", icon: "javascript" },
  mjs: { languageId: "javascript", icon: "javascript" },
  cjs: { languageId: "javascript", icon: "javascript" },
  jsx: { languageId: "javascript", icon: "javascript" },
  // TypeScript
  ts: { languageId: "typescript", icon: "typescript" },
  tsx: { languageId: "typescript", icon: "typescript" },
  mts: { languageId: "typescript", icon: "typescript" },
  cts: { languageId: "typescript", icon: "typescript" },
  // CSS family
  css: { languageId: "css", icon: "css" },
  scss: { languageId: "scss", icon: "css" },
  less: { languageId: "less", icon: "css" },
  // HTML
  html: { languageId: "html", icon: "html" },
  htm: { languageId: "html", icon: "html" },
  // XML (csproj & friends are first-class Dev Mode content)
  xml: { languageId: "xml", icon: "xml" },
  config: { languageId: "xml", icon: "xml" },
  csproj: { languageId: "xml", icon: "xml" },
  fsproj: { languageId: "xml", icon: "xml" },
  vbproj: { languageId: "xml", icon: "xml" },
  vcxproj: { languageId: "xml", icon: "xml" },
  props: { languageId: "xml", icon: "xml" },
  targets: { languageId: "xml", icon: "xml" },
  slnx: { languageId: "xml", icon: "xml" },
  xaml: { languageId: "xml", icon: "xml" },
  resx: { languageId: "xml", icon: "xml" },
  svg: { languageId: "xml", icon: "xml" },
  plist: { languageId: "xml", icon: "xml" },
  manifest: { languageId: "xml", icon: "xml" },
  // JSON
  json: { languageId: "json", icon: "json" },
  map: { languageId: "json", icon: "json" },
  // Markdown (readme/changelog in tree)
  md: { languageId: "markdown", icon: "markdown" },
  markdown: { languageId: "markdown", icon: "markdown" },
  // Plain text — own quiet TX badge (user request); other unknown
  // extensions still fall through to the plain FileText glyph.
  txt: { languageId: "plaintext", icon: "txt" },
};

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "tiff", "tif",
  "pdf", "zip", "rar", "7z", "tar", "gz", "bz2", "xz",
  "dll", "exe", "so", "dylib", "pdb", "obj", "lib", "a", "o",
  "snk", "pfx", "cer", "der", "crt",
  "ttf", "otf", "woff", "woff2",
  "mp3", "mp4", "mov", "avi", "wav", "aac", "flac", "m4a",
  "xls", "xlsx", "doc", "docx", "ppt", "pptx",
  "suo", "user", "cache",
]);

export function fileExtensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function languageForPath(path: string): LanguageInfo {
  return EXT_LANGUAGE[fileExtensionOf(path)] ?? PLAINTEXT;
}

export function isProbablyBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(fileExtensionOf(path));
}

/**
 * Image extensions the File Reader window renders as <img>. Mirrors
 * IMAGE_EXTENSIONS in screens/reader/FileReaderController.ts — keep both
 * sets in sync (no tiff: Chromium can't render it, reader falls to code).
 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "ico",
]);

/** True when the path should preview in the File Reader, not the editor. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtensionOf(path));
}
