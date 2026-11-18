
import {
  isTsJsPath,
  scanDocumentSymbols,
  type DocumentSymbol,
  type DocumentSymbolKind,
} from "./documentSymbols.js";
import { isCppHeaderPath, isCppSourcePath } from "./cppHeaderOutline.js";

export type CppSymbolEntryKind = Extract<
  DocumentSymbolKind,
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "type"
  | "function"
  | "variable"
>;

export type CppSymbolEntry = {
  name: string;
  kind: CppSymbolEntryKind;
  path: string;
  line: number;
  container?: string;
  containerChain?: string;
  params?: string;
  returnType?: string;
  isImpl?: boolean;
};

export const CPP_INDEX_MAX_FILES = 6000;
export const CPP_INDEX_MAX_ENTRIES = 60000;
export const CPP_INDEX_MAX_FILE_BYTES = 512 * 1024;
export const CPP_INDEX_DEADLINE_MS = 8000;
const CPP_INDEX_CHUNK = 60;
const MAX_SYMBOLS_PER_FILE = 400;

export function isCppIndexablePath(path: string): boolean {
  return isCppHeaderPath(path) || isCppSourcePath(path);
}

const SYMBOL_SKIP_DIR_NAMES = new Set<string>([
  "bin",
  "obj",
  "node_modules",
  "packages",
  "testresults",
  "dist",
  "out",
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
  "engine",
]);

export function isSkippedSymbolDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SYMBOL_SKIP_DIR_NAMES.has(name.toLowerCase());
}

export type CppSymbolScanRoots = {
  workspaceRoot: string;
  extraRoots: readonly string[];
};

function scanRootKey(path: string, fold: boolean): string {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return fold ? norm.toLowerCase() : norm;
}

export function coveringSymbolScanRoot(
  dir: string,
  roots: CppSymbolScanRoots,
  caseInsensitive: boolean,
): string | null {
  const dirKey = scanRootKey(dir, caseInsensitive);
  const candidates = [roots.workspaceRoot, ...roots.extraRoots];
  for (const root of candidates) {
    const rootKey = scanRootKey(root, caseInsensitive);
    if (rootKey === "") continue;
    if (dirKey === rootKey) return root;
    if (!dirKey.startsWith(`${rootKey}/`)) continue;
    const tail = dirKey.slice(rootKey.length + 1);
    if (tail.split("/").some((segment) => isSkippedSymbolDir(segment))) {
      continue;
    }
    return root;
  }
  return null;
}

const CONTROL_TAIL_RE =
  /(?:\b(?:if|for|while|switch|return|else|do|catch|new|delete|co_await|co_return)\s*)$/;

const QUALIFIED_DEF_RE = /((?:[A-Za-z_]\w*::)+)(~?[A-Za-z_]\w*)\s*\(/g;

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripReturnPrefix(s: string): string {
  let out = collapseWs(s);
  const leading =
    /^(?:virtual|static|explicit|constexpr|inline|forceinline|FORCEINLINE|friend|typename|mutable|UE_DEPRECATED[\w.]*|ANALYZER_NORETURN)\s+/;
  for (let n = 0; n < 8; n++) {
    const next = out.replace(leading, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function sliceParams(line: string, openIndex: number): {
  params: string;
  closeIndex: number;
} {
  if (openIndex < 0 || line[openIndex] !== "(") {
    return { params: "", closeIndex: -1 };
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        const params = collapseWs(line.slice(openIndex + 1, i));
        return {
          params: params.length > 200 ? `${params.slice(0, 200)}…` : params,
          closeIndex: i,
        };
      }
    }
  }
  return { params: "", closeIndex: -1 };
}

export function scanCppImplLine(line: string): {
  name: string;
  container: string;
  containerChain: string;
  params?: string;
  returnType?: string;
} | null {
  const hash = line.indexOf("#");
  const cut = line.indexOf("//");
  const scanEnd = cut >= 0 ? cut : line.length;
  if (hash >= 0 && hash < scanEnd) return null;
  const text = line.slice(0, scanEnd);
  QUALIFIED_DEF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUALIFIED_DEF_RE.exec(text)) !== null) {
    const prefix = text.slice(0, m.index);
    if (/[("';}=]/.test(prefix)) continue;
    if (/^\s*[+\-*/%.!?|^,<>]/.test(prefix) || /[+\-!?|^,]\s*$/.test(prefix)) continue;
    if (CONTROL_TAIL_RE.test(prefix)) continue;
    const containerChain = m[1]!;
    const name = m[2]!;
    const openParen = m.index + m[0].length - 1;
    const { params, closeIndex } = sliceParams(text, openParen);
    if (closeIndex < 0) continue;
    const rest = text.slice(closeIndex + 1);
    if (/^\s*(?:const\s*)?;/.test(rest) && !rest.includes("{")) continue;
    if (/^\s*(?:\.|->)/.test(rest)) continue;
    const segments = containerChain.split("::");
    const container = segments[segments.length - 2] ?? "";
    const returnType = stripReturnPrefix(prefix);
    const out: {
      name: string;
      container: string;
      containerChain: string;
      params?: string;
      returnType?: string;
    } = { name, container, containerChain };
    if (params) out.params = params;
    if (returnType) out.returnType = returnType;
    return out;
  }
  return null;
}

export function scanCppImplSymbols(
  text: string,
  path: string,
  maxSymbols: number = MAX_SYMBOLS_PER_FILE,
): CppSymbolEntry[] {
  const lines = text.split(/\r?\n/);
  const out: CppSymbolEntry[] = [];
  const seen = new Set<number>();
  const capped = Number.isFinite(maxSymbols);
  for (
    let i = 0;
    i < lines.length && (!capped || out.length < maxSymbols);
    i++
  ) {
    const raw = lines[i]!;
    if (raw.length > 400) continue;
    const trimmed = raw.trimStart();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) {
      continue;
    }
    let span = raw;
    let j = i;
    let hit = scanCppImplLine(span);
    while (
      !hit &&
      j + 1 < lines.length &&
      j - i < 4 &&
      span.length < 1200 &&
      span.split("(").length - 1 > span.split(")").length - 1
    ) {
      j += 1;
      span = `${span} ${lines[j]!.trim()}`;
      hit = scanCppImplLine(span);
    }
    if (!hit) continue;
    for (let k = i; k <= j && (!capped || out.length < maxSymbols); k++) {
      seen.add(k);
    }
    out.push({
      name: hit.name,
      kind: "function",
      path,
      line: i + 1,
      container: hit.container,
      containerChain: hit.containerChain,
      ...(hit.params !== undefined ? { params: hit.params } : {}),
      ...(hit.returnType !== undefined ? { returnType: hit.returnType } : {}),
      isImpl: true,
    });
    i = j;
  }
  return out;
}

const CONTAINER_KINDS: ReadonlySet<DocumentSymbolKind> = new Set([
  "class",
  "interface",
  "struct",
  "enum",
  "type",
]);

export function scanCppDeclSymbols(
  text: string,
  path: string,
  maxSymbols: number = MAX_SYMBOLS_PER_FILE,
): CppSymbolEntry[] {
  const symbols = scanDocumentSymbols(text, { path, maxSymbols });
  const out: CppSymbolEntry[] = [];
  const stack: string[] = [];
  const implLines = new Set<number>();
  const capped = Number.isFinite(maxSymbols);
  for (const s of symbols) {
    if (capped && out.length >= maxSymbols) break;
    while (stack.length > s.depth) stack.pop();
    if (
      (s.kind === "function" || s.kind === "variable") &&
      !implLines.has(s.line)
    ) {
      const container = stack[stack.length - 1];
      out.push({
        name: s.name,
        kind: s.kind,
        path,
        line: s.line,
        ...(container ? { container } : {}),
        ...(s.params !== undefined ? { params: s.params } : {}),
        ...(s.returnType !== undefined ? { returnType: s.returnType } : {}),
      });
    } else if (CONTAINER_KINDS.has(s.kind)) {
      out.push({
        name: s.name,
        kind: s.kind as CppSymbolEntryKind,
        path,
        line: s.line,
        ...(stack.length > 0 ? { container: stack[stack.length - 1] } : {}),
      });
    }
    if (CONTAINER_KINDS.has(s.kind)) {
      stack.length = s.depth;
      stack.push(s.name);
    }
  }
  return out;
}


const FREE_FN_REJECT_PREFIX_RE =
  /^(?:typedef|using|return|delete|new|throw|case|goto|else|do|friend|class|struct|enum|union|namespace|template|co_return|co_await|static_assert)\b/;
const FREE_FN_DECORATION_RE =
  /\b(?:static|inline|extern|constexpr|consteval|FORCEINLINE|FORCENOINLINE|FORCEINLINE_DEBUGGABLE|UE_NODISCARD|\[\[[^\]]*\]\]|[A-Z][A-Z0-9_]*_API)\s+/g;

function stripTemplatePrefix(s: string): string {
  const m = /^\s*template\s*</.exec(s);
  if (!m) return s;
  let depth = 0;
  for (let i = m[0].length - 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "<") depth += 1;
    else if (ch === ">") {
      depth -= 1;
      if (depth === 0) return s.slice(i + 1).trim();
    }
  }
  return s;
}

function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(" || ch === "<" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === ">" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function looksLikeParamList(params: string): boolean {
  const body = params.trim();
  if (!body || body === "void") return true;
  for (const param of splitTopLevel(body)) {
    const decl = param.split("=")[0]!.trim();
    if (!decl) return false;
    if (/^(?:["'\d.-]|TEXT\s*\(|nullptr\b|true\b|false\b|this\b|&[A-Za-z_]|sizeof\b|new\b)/.test(decl)) {
      return false;
    }
    if (/\(/.test(decl) && !/\(\s*[*&]/.test(decl)) return false;
  }
  return true;
}

export function matchFreeFunction(span: string): {
  name: string;
  params: string;
  returnType: string;
} | null {
  let s = collapseWs(span);
  if (!s || s.startsWith("#")) return null;
  s = stripTemplatePrefix(s);
  if (FREE_FN_REJECT_PREFIX_RE.test(s)) return null;
  const paren = s.indexOf("(");
  if (paren <= 0) return null;
  const before = s.slice(0, paren);
  const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(before);
  if (!nameMatch || nameMatch.index === undefined) return null;
  const name = nameMatch[1]!;
  if (CONTROL_TAIL_RE.test(`${name}`) || /^(?:operator|decltype|alignas|sizeof)$/.test(name)) return null;
  const prefix = before.slice(0, nameMatch.index).trimEnd();
  if (!prefix || prefix.endsWith("::") || /operator\s*$/.test(prefix)) return null;
  if (/[=(),;{}"'#]/.test(prefix) || /\breturn\b/.test(prefix)) return null;
  if (!/[\w*&>]$/.test(prefix)) return null;
  const typeText = prefix.replace(FREE_FN_DECORATION_RE, "").trim();
  if (!typeText) return null;
  const { params, closeIndex } = sliceParams(s, paren);
  if (closeIndex < 0) return null;
  const rest = s.slice(closeIndex + 1).trim();
  if (
    rest &&
    !/^(?:noexcept(?:\s*\([^)]*\))?\s*)?(?:->\s*[^;{]+?\s*)?(?:[;{]|=\s*(?:delete|default)\s*;)/.test(rest)
  ) {
    return null;
  }
  if (!looksLikeParamList(params)) return null;
  return { name, params, returnType: stripReturnPrefix(typeText) };
}

function stripCppComments(
  line: string,
  inBlock: boolean,
): { code: string; inBlock: boolean } {
  let out = "";
  let i = 0;
  let block = inBlock;
  let quote: string | null = null;
  while (i < line.length) {
    const ch = line[i]!;
    if (block) {
      const end = line.indexOf("*/", i);
      if (end < 0) return { code: out, inBlock: true };
      i = end + 2;
      block = false;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < line.length) {
        out += line[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "/" && line[i + 1] === "*") {
      block = true;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { code: out, inBlock: block };
}

export function scanCppFreeFunctions(
  text: string,
  path: string,
  maxSymbols: number = MAX_SYMBOLS_PER_FILE,
): CppSymbolEntry[] {
  const lines = text.split(/\r?\n/);
  const out: CppSymbolEntry[] = [];
  const blocks: boolean[] = [];
  let head = "";
  let inBlock = false;
  let inMacro = false;
  let quote: string | null = null;
  const capped = Number.isFinite(maxSymbols);
  const atFileScope = () => blocks.every(Boolean);

  for (let i = 0; i < lines.length && (!capped || out.length < maxSymbols); i++) {
    const raw = lines[i]!;
    if (inMacro || /^\s*#/.test(raw)) {
      inMacro = /\\\s*$/.test(raw);
      continue;
    }
    if (raw.length > 600) continue;
    const { code, inBlock: nextBlock } = stripCppComments(raw, inBlock);
    inBlock = nextBlock;

    if (atFileScope() && code.includes("(") && !/\(/.test(head)) {
      let span = `${head} ${code}`;
      let j = i;
      let comment = inBlock;
      while (
        span.split("(").length - 1 > span.split(")").length - 1 &&
        j + 1 < lines.length &&
        j - i < 8
      ) {
        j += 1;
        const next = stripCppComments(lines[j]!, comment);
        comment = next.inBlock;
        span = `${span} ${next.code}`;
      }
      const hit = matchFreeFunction(span);
      if (hit && !scanCppImplLine(span)) {
        out.push({
          name: hit.name,
          kind: "function",
          path,
          line: i + 1,
          ...(hit.params ? { params: hit.params } : {}),
          ...(hit.returnType ? { returnType: hit.returnType } : {}),
        });
      }
    }

    for (let k = 0; k < code.length; k++) {
      const ch = code[k]!;
      if (quote) {
        head += ch;
        if (ch === "\\") {
          head += code[k + 1] ?? "";
          k += 1;
        } else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        head += ch;
        continue;
      }
      if (ch === "{") {
        const transparent =
          atFileScope() &&
          (/\bnamespace\b[^;{}()]*$/.test(head) || /\bextern\s*"C(?:\+\+)?"\s*$/.test(head));
        blocks.push(transparent);
        head = "";
      } else if (ch === "}") {
        blocks.pop();
        head = "";
      } else if (ch === ";") {
        head = "";
      } else {
        head += ch;
      }
    }
    quote = null;
    const pending = head.trim();
    if (
      /^[A-Z][A-Z0-9_]*(?:\s*\(.*\))?$/.test(pending) &&
      pending.split("(").length === pending.split(")").length
    ) {
      head = "";
    }
    head += " ";
    if (head.length > 2000) head = head.slice(-1000);
  }
  return out;
}

export function scanCppIndexSymbols(
  text: string,
  path: string,
  options?: { maxSymbols?: number },
): CppSymbolEntry[] {
  if (!isCppIndexablePath(path)) return [];
  const norm = path.replace(/\\/g, "/");
  const maxSymbols = options?.maxSymbols ?? MAX_SYMBOLS_PER_FILE;
  const impls = scanCppImplSymbols(text, norm, maxSymbols);
  const implLines = new Set(impls.map((entry) => entry.line));
  const decls = scanCppDeclSymbols(text, norm, maxSymbols).filter(
    (entry) => !(entry.kind === "function" && implLines.has(entry.line)),
  );
  const declLines = new Set(decls.map((entry) => entry.line));
  const free = scanCppFreeFunctions(text, norm, maxSymbols).filter(
    (entry) => !implLines.has(entry.line) && !declLines.has(entry.line),
  );
  return [...impls, ...decls, ...free];
}


const INDEX_ENTRY_KINDS = new Set<DocumentSymbolKind>([
  "class",
  "interface",
  "struct",
  "enum",
  "type",
  "function",
  "variable",
]);

const CSS_EXT = /\.css$/i;

export function isCssPath(path: string): boolean {
  return CSS_EXT.test(path.replace(/\\/g, "/"));
}

export function isSymbolIndexablePath(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return isCppIndexablePath(norm) || isTsJsPath(norm) || isCssPath(norm);
}

function scanTsIndexSymbols(
  text: string,
  path: string,
  maxSymbols: number,
): CppSymbolEntry[] {
  const symbols = scanDocumentSymbols(text, { path, maxSymbols });
  const out: CppSymbolEntry[] = [];
  const stack: string[] = [];
  for (const s of symbols) {
    while (stack.length > s.depth) stack.pop();
    if (INDEX_ENTRY_KINDS.has(s.kind)) {
      const entry: CppSymbolEntry = {
        name: s.name,
        kind: s.kind as CppSymbolEntryKind,
        path,
        line: s.line,
      };
      const container = stack[stack.length - 1];
      if (container) entry.container = container;
      if (s.params !== undefined) entry.params = s.params;
      if (s.returnType !== undefined) entry.returnType = s.returnType;
      out.push(entry);
    }
    if (
      s.kind !== "function" &&
      s.kind !== "variable" &&
      s.kind !== "access"
    ) {
      stack.length = s.depth;
      stack.push(s.name);
    }
  }
  return out;
}

const CSS_SELECTOR_RE = /^([^@{}]+?)\s*\{/;
const CSS_KEYFRAMES_RE = /@keyframes\s+([A-Za-z_-][\w-]*)/i;
const CSS_VAR_RE = /(?<![\w-])(--[\w-]+)\s*:/;
const MAX_CSS_NAME_CHARS = 120;

function stripCssComments(
  line: string,
  inComment: boolean,
): { text: string; inComment: boolean } {
  let out = "";
  let rest = line;
  let commenting = inComment;
  while (rest.length > 0) {
    if (commenting) {
      const end = rest.indexOf("*/");
      if (end === -1) return { text: out, inComment: true };
      rest = rest.slice(end + 2);
      commenting = false;
      continue;
    }
    const start = rest.indexOf("/*");
    if (start === -1) return { text: out + rest, inComment: false };
    out += rest.slice(0, start);
    rest = rest.slice(start + 2);
    commenting = true;
  }
  return { text: out, inComment: commenting };
}

function clipCssName(name: string): string {
  return name.length <= MAX_CSS_NAME_CHARS
    ? name
    : `${name.slice(0, MAX_CSS_NAME_CHARS)}…`;
}

function scanCssIndexSymbols(text: string, path: string): CppSymbolEntry[] {
  const out: CppSymbolEntry[] = [];
  const lines = text.split(/\r?\n/);
  let depth = 0;
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripCssComments(lines[i]!, inComment);
    inComment = stripped.inComment;
    const line = stripped.text;
    const varMatch = CSS_VAR_RE.exec(line);
    if (varMatch) {
      out.push({
        name: varMatch[1]!,
        kind: "variable",
        path,
        line: i + 1,
      });
    }
    if (depth === 0) {
      const trimmed = line.trim();
      const keyframes = CSS_KEYFRAMES_RE.exec(trimmed);
      if (keyframes) {
        out.push({
          name: keyframes[1]!,
          kind: "type",
          path,
          line: i + 1,
        });
      } else if (!trimmed.startsWith("@")) {
        const selector = CSS_SELECTOR_RE.exec(line);
        if (selector) {
          out.push({
            name: clipCssName(collapseWs(selector[1]!)),
            kind: "type",
            path,
            line: i + 1,
          });
        }
      }
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    depth = Math.max(0, depth + opens - closes);
  }
  return out;
}

export function scanIndexSymbols(
  text: string,
  path: string,
  options?: { maxSymbols?: number },
): CppSymbolEntry[] {
  const norm = path.replace(/\\/g, "/");
  if (isCppIndexablePath(norm)) return scanCppIndexSymbols(text, norm, options);
  if (isTsJsPath(norm)) {
    return scanTsIndexSymbols(
      text,
      norm,
      options?.maxSymbols ?? MAX_SYMBOLS_PER_FILE,
    );
  }
  if (isCssPath(norm)) return scanCssIndexSymbols(text, norm);
  return [];
}

const SOURCE_PREFERRED_ORDER = (path: string): number =>
  isCppHeaderPath(path) ? 0 : 1;

export function buildCppFileList(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const norm = raw.replace(/\\/g, "/");
    if (!isCppIndexablePath(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  out.sort(
    (a, b) =>
      SOURCE_PREFERRED_ORDER(a) - SOURCE_PREFERRED_ORDER(b) ||
      a.length - b.length ||
      (a < b ? -1 : 1),
  );
  return out.slice(0, CPP_INDEX_MAX_FILES);
}

export function isCppSiblingFile(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/");
  const nb = b.replace(/\\/g, "/");
  if (na === nb) return true;
  const dir = (p: string): string => p.slice(0, p.lastIndexOf("/"));
  const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
  const stripExt = (p: string): string => p.replace(/\.[^.]+$/, "");
  const dnb = dir(nb);
  const dirs = new Set<string>([
    dnb,
    dnb.replace(/\/Private\b/i, "/Public"),
    dnb.replace(/\/Public\b/i, "/Private"),
    dnb.replace(/\/Private$/i, ""),
  ]);
  for (const d of dirs) {
    if (dir(na) !== d) continue;
    if (stripExt(base(na)) === stripExt(base(nb))) return true;
  }
  return false;
}


export type CppIndexStats = {
  state: "idle" | "building" | "ready";
  root: string | null;
  fileCount: number;
  symbolCount: number;
  truncatedFiles: boolean;
  truncatedEntries: boolean;
};

export type CppIndexDeps = {
  listCppFiles: (root: string) => Promise<string[]>;
  readTextFile: (path: string) => Promise<string | null>;
  yieldToUi?: () => Promise<void>;
};

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export class CppWorkspaceIndex {
  private readonly deps: CppIndexDeps;
  private readonly byName = new Map<string, CppSymbolEntry[]>();
  private readonly byPath = new Map<string, CppSymbolEntry[]>();
  private buildPromise: Promise<void> | null = null;
  private rootKey: string | null = null;
  private state: CppIndexStats["state"] = "idle";
  private stats: CppIndexStats = {
    state: "idle",
    root: null,
    fileCount: 0,
    symbolCount: 0,
    truncatedFiles: false,
    truncatedEntries: false,
  };

  constructor(deps: CppIndexDeps) {
    this.deps = deps;
  }

  getStats(): CppIndexStats {
    return { ...this.stats, state: this.state, root: this.rootKey };
  }

  ensure(root: string): Promise<void> {
    const norm = root.replace(/\\/g, "/");
    if (this.rootKey === norm && (this.state === "ready" || this.buildPromise)) {
      return this.buildPromise ?? Promise.resolve();
    }
    this.rootKey = norm;
    this.resetEntries();
    this.state = "building";
    this.stats = {
      ...this.stats,
      state: "building",
      root: norm,
      fileCount: 0,
      symbolCount: 0,
      truncatedFiles: false,
      truncatedEntries: false,
    };
    this.buildPromise = this.build(norm).finally(() => {
      this.buildPromise = null;
      this.state = "ready";
      this.stats.state = "ready";
    });
    return this.buildPromise;
  }

  private async build(root: string): Promise<void> {
    const deadline = Date.now() + CPP_INDEX_DEADLINE_MS;
    let files: string[];
    try {
      files = await this.deps.listCppFiles(root);
    } catch {
      files = [];
    }
    const list = files.some((f) => !isCppIndexablePath(f))
      ? buildCppFileList(files)
      : files
          .map((f) => f.replace(/\\/g, "/"))
          .sort(
            (a, b) =>
              SOURCE_PREFERRED_ORDER(a) - SOURCE_PREFERRED_ORDER(b) ||
              a.length - b.length,
          );
    if (list.length > CPP_INDEX_MAX_FILES) {
      this.stats.truncatedFiles = true;
    }
    for (let i = 0; i < list.length; i += CPP_INDEX_CHUNK) {
      if (Date.now() > deadline) {
        this.stats.truncatedFiles = true;
        break;
      }
      const chunk = list.slice(i, i + CPP_INDEX_CHUNK);
      const texts = await Promise.all(
        chunk.map(async (path) => {
          try {
            return await this.deps.readTextFile(path);
          } catch {
            return null;
          }
        }),
      );
      for (let k = 0; k < chunk.length; k++) {
        const path = chunk[k]!;
        const text = texts[k];
        if (text === null || text === undefined) continue;
        if (text.length > CPP_INDEX_MAX_FILE_BYTES) continue;
        this.stats.fileCount += 1;
        this.replacePathEntries(path, scanCppIndexSymbols(text, path));
        if (this.stats.symbolCount >= CPP_INDEX_MAX_ENTRIES) {
          this.stats.truncatedEntries = true;
          return;
        }
      }
      await (this.deps.yieldToUi?.() ?? defaultYield());
    }
  }

  upsertFile(path: string, text: string): void {
    if (!isCppIndexablePath(path)) return;
    const norm = path.replace(/\\/g, "/");
    if (text.length > CPP_INDEX_MAX_FILE_BYTES) return;
    this.replacePathEntries(norm, scanCppIndexSymbols(text, norm));
  }

  getEntries(word: string): CppSymbolEntry[] {
    return this.byName.get(word.toLowerCase()) ?? [];
  }

  reset(): void {
    this.rootKey = null;
    this.resetEntries();
    this.state = "idle";
    this.stats = {
      state: "idle",
      root: null,
      fileCount: 0,
      symbolCount: 0,
      truncatedFiles: false,
      truncatedEntries: false,
    };
  }

  private resetEntries(): void {
    this.byName.clear();
    this.byPath.clear();
  }

  private replacePathEntries(path: string, entries: CppSymbolEntry[]): void {
    const norm = path.replace(/\\/g, "/");
    const prev = this.byPath.get(norm);
    if (prev) {
      for (const entry of prev) {
        const bucket = this.byName.get(entry.name.toLowerCase());
        if (!bucket) continue;
        const idx = bucket.indexOf(entry);
        if (idx >= 0) bucket.splice(idx, 1);
        if (bucket.length === 0) this.byName.delete(entry.name.toLowerCase());
      }
      this.stats.symbolCount -= prev.length;
    }
    if (entries.length === 0) {
      if (prev) this.byPath.delete(norm);
      return;
    }
    this.byPath.set(norm, entries);
    this.stats.symbolCount += entries.length;
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      const bucket = this.byName.get(key);
      if (bucket) bucket.push(entry);
      else this.byName.set(key, [entry]);
    }
  }
}
