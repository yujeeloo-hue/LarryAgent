
export const HEADER_FILE_RE = /\.(?:h|hh|hpp|hxx|inl|ipp)$/i;
const GENERATED_FILE_RE = /\.(?:generated|gen)\.(?:h|cpp)$/i;
const INCLUDE_DIR_FLAG_RE = /^(?:\/external:I|\/I|-external:I|-isystem|-iquote|-idirafter|-imsvc|-I)(.*)$/;
const INCLUDE_LINE_RE = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/;
const GENERATED_INCLUDE_RE = /\.generated\.h["'>]/i;

export function isHeaderPath(path: string): boolean {
  return HEADER_FILE_RE.test(path);
}

export function normalizeFsPath(path: string): string {
  let out = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (out.length > 1) out = out.replace(/\/+$/, "");
  if (/^[A-Za-z]:$/.test(out)) out = `${out}/`;
  return out;
}

export function fileNameOf(path: string): string {
  const norm = normalizeFsPath(path);
  return norm.slice(norm.lastIndexOf("/") + 1);
}

export function parentDirOf(path: string): string {
  const norm = normalizeFsPath(path);
  const cut = norm.lastIndexOf("/");
  return cut <= 0 ? norm.slice(0, cut + 1) || "." : norm.slice(0, cut);
}

function isAbsoluteLike(path: string): boolean {
  return /^(?:[A-Za-z]:\/|\/)/.test(path);
}

function normalizeDotSegments(path: string): string {
  const absolute = isAbsoluteLike(path);
  const drive = /^([A-Za-z]:)\//.exec(path)?.[1] ?? "";
  const rest = drive ? path.slice(drive.length) : path;
  const out: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const body = out.join("/");
  if (drive) return `${drive}/${body}`;
  return absolute ? `/${body}` : body;
}

function resolveAgainst(base: string, value: string): string {
  if (isAbsoluteLike(value)) return normalizeDotSegments(value);
  if (!base) return normalizeDotSegments(value);
  return normalizeDotSegments(`${normalizeFsPath(base)}/${value}`);
}

export function includeDirsFromArgs(
  args: readonly string[],
  directory: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const match = INCLUDE_DIR_FLAG_RE.exec(args[i] ?? "");
    if (!match) continue;
    let value = (match[1] ?? "").trim();
    if (!value) {
      value = (args[i + 1] ?? "").trim();
      i += 1;
    }
    value = value.replace(/^"(.*)"$/, "$1").trim();
    if (!value) continue;
    const dir = resolveAgainst(directory, value);
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

export function includeSpecifierFor(
  headerPath: string,
  includeDirs: readonly string[],
  forFile?: string,
): string | null {
  const header = normalizeFsPath(headerPath);
  if (!header || GENERATED_FILE_RE.test(header)) return null;
  if (!isHeaderPath(header)) return null;
  if (/\/intermediate\//i.test(header)) return null;
  const lowerHeader = header.toLowerCase();
  if (forFile) {
    const headerDir = parentDirOf(header);
    const forDir = parentDirOf(normalizeFsPath(forFile));
    if (headerDir.toLowerCase() === forDir.toLowerCase()) return fileNameOf(header);
  }
  let best: { prefixLength: number; rel: string } | null = null;
  for (const raw of includeDirs) {
    const dir = normalizeFsPath(raw);
    if (!dir) continue;
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    if (!lowerHeader.startsWith(prefix.toLowerCase())) continue;
    const rel = header.slice(prefix.length);
    if (!rel) continue;
    if (!best || prefix.length > best.prefixLength) best = { prefixLength: prefix.length, rel };
  }
  return best?.rel ?? null;
}

export function existingIncludes(text: string): IncludedIncludes {
  const specifiers = new Set<string>();
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = INCLUDE_LINE_RE.exec(line);
    if (!match) continue;
    const specifier = normalizeFsPath(match[1] ?? "").toLowerCase();
    if (!specifier) continue;
    specifiers.add(specifier);
    names.add(fileNameOf(specifier));
  }
  return { specifiers, names };
}

export type IncludedIncludes = { specifiers: Set<string>; names: Set<string> };

export function includesSpecifier(included: IncludedIncludes, specifier: string): boolean {
  const spec = normalizeFsPath(specifier).toLowerCase();
  if (!spec) return true;
  return included.specifiers.has(spec) || included.names.has(fileNameOf(spec));
}

export function alreadyIncluded(text: string, specifier: string): boolean {
  return includesSpecifier(existingIncludes(text), specifier);
}

export type IncludeInsertion = { line: number; text: string };

function includeLineIndexes(lines: readonly string[]): number[] {
  const out: number[] = [];
  lines.forEach((line, index) => {
    if (INCLUDE_LINE_RE.test(line)) out.push(index);
  });
  return out;
}

function prologueEnd(lines: readonly string[]): number {
  let inBlock = false;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed) last = i;
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (!trimmed) continue;
    if (trimmed.startsWith("//")) {
      last = i;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      last = i;
      inBlock = !trimmed.includes("*/");
      continue;
    }
    if (/^#\s*(?:pragma|if|ifdef|ifndef|define|endif|include)\b/.test(trimmed)) {
      last = i;
      continue;
    }
    break;
  }
  return last;
}

function insertionText(specifier: string): string {
  return `#include "${specifier}"\n`;
}

export function includeInsertionLine(text: string): number {
  const lines = text.split("\n");
  const includeLines = includeLineIndexes(lines);
  const generatedLine = includeLines
    .filter((index) => GENERATED_INCLUDE_RE.test(lines[index] ?? ""))
    .at(-1);
  if (generatedLine !== undefined) return generatedLine + 1;
  const lastInclude = includeLines.at(-1);
  if (lastInclude !== undefined) return lastInclude + 2;
  const prologue = prologueEnd(lines);
  return prologue >= 0 ? prologue + 2 : 1;
}

export function includeInsertionFor(text: string, specifier: string): IncludeInsertion {
  return { line: includeInsertionLine(text), text: insertionText(specifier) };
}

export function planIncludeInsertion(
  text: string,
  specifier: string,
  filePath?: string,
): IncludeInsertion | null {
  void filePath;
  const spec = specifier.trim().replace(/^[<"]+/, "").replace(/[>"]+$/, "");
  if (!spec) return null;
  if (alreadyIncluded(text, spec)) return null;
  return includeInsertionFor(text, spec);
}

export function planAutoImport(
  headerPath: string | undefined,
  includeDirs: readonly string[],
  forFile: string,
  included: IncludedIncludes,
  insertionLine: number,
): { specifier: string; insertion: IncludeInsertion } | null {
  if (!headerPath) return null;
  const specifier = includeSpecifierFor(headerPath, includeDirs, forFile);
  if (!specifier || includesSpecifier(included, specifier)) return null;
  return { specifier, insertion: { line: insertionLine, text: insertionText(specifier) } };
}
