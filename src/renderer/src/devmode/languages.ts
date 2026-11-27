
export type FileIconKey =
  | "csharp"
  | "cpp"
  | "python"
  | "swift"
  | "lua"
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
  languageId: string;
  icon: FileIconKey;
};

const PLAINTEXT: LanguageInfo = { languageId: "plaintext", icon: "text" };

const EXT_LANGUAGE: Record<string, LanguageInfo> = {
  cs: { languageId: "csharp", icon: "csharp" },
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
  py: { languageId: "python", icon: "python" },
  pyw: { languageId: "python", icon: "python" },
  pyi: { languageId: "python", icon: "python" },
  swift: { languageId: "swift", icon: "swift" },
  lua: { languageId: "lua", icon: "lua" },
  js: { languageId: "javascript", icon: "javascript" },
  mjs: { languageId: "javascript", icon: "javascript" },
  cjs: { languageId: "javascript", icon: "javascript" },
  jsx: { languageId: "javascript", icon: "javascript" },
  ts: { languageId: "typescript", icon: "typescript" },
  tsx: { languageId: "typescript", icon: "typescript" },
  mts: { languageId: "typescript", icon: "typescript" },
  cts: { languageId: "typescript", icon: "typescript" },
  css: { languageId: "css", icon: "css" },
  scss: { languageId: "scss", icon: "css" },
  less: { languageId: "less", icon: "css" },
  html: { languageId: "html", icon: "html" },
  htm: { languageId: "html", icon: "html" },
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
  json: { languageId: "json", icon: "json" },
  map: { languageId: "json", icon: "json" },
  md: { languageId: "markdown", icon: "markdown" },
  markdown: { languageId: "markdown", icon: "markdown" },
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

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtensionOf(path));
}
