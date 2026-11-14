import { isCppHeaderPath, isCppSourcePath, scanCppHeader } from "./cppHeaderOutline.js";

/**
 * Document Outline symbols from source text (no LSP).
 *
 * Line-oriented scan used by the left-pane Outline and by Quick Open
 * (`scanQuickOpenSymbols`). Nested depth follows indent so methods sit
 * under the enclosing type when the file is indented that way.
 *
 * C++ / Unreal: Outline skips `.cpp` implementation files. Quick Open
 * still indexes `Class::Method` definitions there. Headers list class /
 * struct names plus `public` / `private` / `protected` member functions
 * and fields (see `scanCppHeader`).
 *
 * TypeScript / JavaScript: only module-level declarations plus
 * class / interface / enum / namespace members. Locals, nested
 * helpers, and calls inside function bodies are omitted.
 *
 * Function rows carry collapsed `params` + `returnType` for the Outline
 * label (multi-line signatures are joined up to the matching `)`).
 */

export type DocumentSymbolKind =
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "type"
  | "function"
  | "variable"
  | "access";

export type DocumentSymbol = {
  name: string;
  kind: DocumentSymbolKind;
  /** 1-based line in the scanned text. */
  line: number;
  depth: number;
  /** Inner parameter list, whitespace collapsed. Empty string → `()`. */
  params?: string;
  /** Return type when present (TS `: T`, Python `-> T`, C++ leading type). */
  returnType?: string;
  /** C++ class member visibility (header Outline). */
  access?: "public" | "private" | "protected";
};

const MAX_SYMBOLS = 400;
const MAX_LINE_CHARS = 400;
const MAX_SIGNATURE_LINES = 16;

const TYPE_KIND: Record<string, DocumentSymbolKind> = {
  class: "class",
  interface: "interface",
  struct: "struct",
  enum: "enum",
  record: "class",
  trait: "interface",
  type: "type",
  namespace: "class",
};

const ENUM_CLASS_RE =
  /^\s*(?:export\s+)?(?:declare\s+)?enum\s+(?:class|struct)\s+([A-Za-z_]\w*)/;
const TYPE_DECL_RE =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+|sealed\s+|static\s+|final\s+|public\s+|private\s+|protected\s+|internal\s+|partial\s+)*(class|interface|struct|enum|record|trait|type|namespace)\s+([A-Za-z_$][\w$]*)(?=\s*[{<:=]|$)/;
const FUNCTION_KW_RE =
  /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const DEF_RE = /\bdef\s+([A-Za-z_]\w*)/;
const RUST_FN_RE =
  /^\s*(?:pub(?:lic)?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+)?"?[^"]*"?fn\s+([A-Za-z_]\w*)/;
const ARROW_TAIL =
  String.raw`\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=>`;
const ARROW_FIELD_RE = new RegExp(
  String.raw`^\s*(?:(?:public|private|protected|static|readonly|async)\s+)*([A-Za-z_$][\w$]*)` +
    ARROW_TAIL,
);
const CONST_ARROW_RE = new RegExp(
  String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)` +
    ARROW_TAIL,
);
const CPP_QUALIFIED_RE = /([A-Za-z_]\w*)::(~?[A-Za-z_]\w*)\s*\(/;
const TS_JS_EXT = /\.([cm]?[jt]sx?)$/i;
const TS_VAR_RE =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/;
const TS_FIELD_RE =
  /^\s*(?:(?:public|private|protected|internal|readonly|static|override|abstract|declare|accessor)\s+)*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*(:|=|;)/;

const CONTROL_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "throw",
  "new",
  "typeof",
  "await",
  "yield",
  "delete",
  "void",
  "case",
  "default",
  "else",
  "do",
  "try",
  "finally",
  "import",
  "export",
  "using",
  "sizeof",
  "foreach",
  "lock",
  "elif",
  "except",
  "lambda",
  "when",
  "match",
  "select",
]);

const LEADING_MODIFIERS =
  /^(?:export|declare|default|async|public|private|protected|internal|static|override|abstract|readonly|virtual|explicit|constexpr|inline|forceinline|FORCEINLINE|friend|typename|function|def|fn)\s+/i;

type LineHit = {
  name: string;
  kind: DocumentSymbolKind;
};

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function skipLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return true;
  if (trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.length > MAX_LINE_CHARS) return true;
  return false;
}

function identBeforeParen(line: string): { name: string; index: number } | null {
  const paren = line.indexOf("(");
  if (paren <= 0) return null;
  const before = line.slice(0, paren);
  const m = /(~?[A-Za-z_$][\w$]*)\s*$/.exec(before);
  if (!m || m.index === undefined) return null;
  return { name: m[1]!, index: m.index };
}

function charBefore(line: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && /[ \t]/.test(line[i]!)) i -= 1;
  return i >= 0 ? line[i]! : "";
}

function looksLikeCall(line: string, nameIndex: number): boolean {
  const prev = charBefore(line, nameIndex);
  // "." / ">" — method or template call; "=" — `T X = T(...)` constructor
  // initializer (the paren belongs to the right-hand call, not a decl).
  if (prev === "." || prev === ">" || prev === "=") return true;
  // `return T(...);` / `return T * new T(...)` — call expression, not decl.
  if (/\breturn\s+[A-Za-z_$][\w$]*\s*\(/.test(line)) return true;
  return false;
}

function hasCppQualifier(line: string, nameIndex: number): boolean {
  const prev = line.slice(Math.max(0, nameIndex - 2), nameIndex);
  return prev.endsWith("::");
}

function hasAccessOrVirtual(line: string): boolean {
  return /^\s*(?:public|private|protected|internal|static|async|override|abstract|virtual|explicit|constexpr|inline|forceinline|FORCEINLINE)\b/.test(
    line,
  );
}

function hasTsReturnType(line: string): boolean {
  return /\)\s*:\s*[A-Za-z_{<[]/.test(line);
}

function endsAsSignature(line: string): boolean {
  const trimmed = line.trimEnd();
  return /[{;]\s*$/.test(trimmed) || /\)\s*$/.test(trimmed);
}

function netOpenParens(s: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  return depth;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripLeadingModifiers(s: string): string {
  let out = collapseWs(s);
  for (let i = 0; i < 8; i++) {
    const next = out.replace(LEADING_MODIFIERS, "");
    if (next === out) break;
    out = next;
  }
  if (/^(?:const|let|var|function|def|fn)$/i.test(out)) return "";
  return out;
}

function nameStartIndex(span: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^\\w$])(${escaped})(?:\\b|(?=$))`);
  const m = re.exec(span);
  if (!m || m.index === undefined || m[1] === undefined) return -1;
  return m.index + m[0].length - m[1].length;
}

function findNameParen(span: string, name: string): number {
  const start = nameStartIndex(span, name);
  if (start >= 0) {
    const after = span.slice(start + name.length);
    const m = /^\s*(?:<[^>]*>\s*)?\(/.exec(after);
    if (m) return start + name.length + m[0].length - 1;
  }
  const eq = span.indexOf("=");
  if (eq >= 0) {
    const paren = span.indexOf("(", eq);
    if (paren >= 0) return paren;
  }
  return span.indexOf("(");
}

function sliceParamList(span: string, openIndex: number): {
  params: string;
  closeIndex: number;
} | null {
  if (openIndex < 0 || span[openIndex] !== "(") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < span.length; i++) {
    const ch = span[i]!;
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          params: collapseWs(span.slice(openIndex + 1, i)).replace(/,\s*$/, ""),
          closeIndex: i,
        };
      }
    }
  }
  return null;
}

function parseReturnAfter(span: string, closeIndex: number): string {
  let rest = span.slice(closeIndex + 1).trim();
  rest = rest.replace(
    /^(?:const|override|final|noexcept|volatile)\s+/i,
    "",
  );
  rest = rest.replace(
    /^(?:const|override|final|noexcept|volatile)\s+/i,
    "",
  );
  if (rest.startsWith("=>") || rest.startsWith("{") || rest.startsWith(";")) {
    return "";
  }
  if (rest.startsWith("->")) {
    const body = rest.slice(2);
    const cut = body.search(/\s*[{:;]/);
    return collapseWs(cut < 0 ? body : body.slice(0, cut));
  }
  if (rest.startsWith(":")) {
    const body = rest.slice(1);
    const cut = body.search(/\s*(?:=>|[{;=])/);
    return collapseWs(cut < 0 ? body : body.slice(0, cut));
  }
  return "";
}

function collectSpan(lines: readonly string[], start: number): string {
  let buf = lines[start] ?? "";
  let j = start;
  while (
    netOpenParens(buf) > 0 &&
    j + 1 < lines.length &&
    j - start < MAX_SIGNATURE_LINES
  ) {
    j += 1;
    const next = lines[j]!.trim();
    if (!next) continue;
    buf += " " + next;
    if (buf.length > 1200) break;
  }
  return buf;
}

function signatureOf(
  span: string,
  name: string,
  leadingReturn: string,
): { params?: string; returnType?: string } {
  if (!span.includes("(")) {
    return leadingReturn ? { returnType: leadingReturn } : {};
  }
  const open = findNameParen(span, name);
  const sliced = sliceParamList(span, open);
  const params = sliced?.params ?? "";
  const close = sliced?.closeIndex ?? -1;
  const after = close >= 0 ? parseReturnAfter(span, close) : "";
  const returnType = after || leadingReturn;
  const out: { params?: string; returnType?: string } = {};
  out.params = params;
  if (returnType) out.returnType = returnType;
  return out;
}

function matchLine(line: string): LineHit | null {
  const enumClass = ENUM_CLASS_RE.exec(line);
  if (enumClass) return { name: enumClass[1]!, kind: "enum" };

  const typeDecl = TYPE_DECL_RE.exec(line);
  if (typeDecl) {
    const kind = TYPE_KIND[typeDecl[1]!] ?? "class";
    return { name: typeDecl[2]!, kind };
  }

  if (/\bfunction\s+[A-Za-z_$]/.test(line)) {
    const m = FUNCTION_KW_RE.exec(line);
    if (m) return { name: m[1]!, kind: "function" };
  }
  if (/\bdef\s+[A-Za-z_]/.test(line)) {
    const m = DEF_RE.exec(line);
    if (m) return { name: m[1]!, kind: "function" };
  }
  const rustFn = RUST_FN_RE.exec(line);
  if (rustFn) return { name: rustFn[1]!, kind: "function" };

  const arrowField = ARROW_FIELD_RE.exec(line) ?? CONST_ARROW_RE.exec(line);
  if (arrowField) return { name: arrowField[1]!, kind: "function" };

  const cpp = CPP_QUALIFIED_RE.exec(line);
  if (
    cpp &&
    line.slice(0, cpp.index).trim().length > 0 &&
    !/\)\s*;\s*$/.test(line.trim())
  ) {
    return { name: cpp[2]!, kind: "function" };
  }

  const ident = identBeforeParen(line);
  if (!ident || CONTROL_NAMES.has(ident.name)) return null;
  if (looksLikeCall(line, ident.index)) return null;
  if (hasCppQualifier(line, ident.index)) return null;

  const unclosed = netOpenParens(line) > 0;
  const definitionShaped =
    hasAccessOrVirtual(line) ||
    hasTsReturnType(line) ||
    /\{/.test(line) ||
    ident.name === "constructor" ||
    unclosed;
  if (!definitionShaped) return null;
  if (
    !unclosed &&
    !endsAsSignature(line) &&
    !hasTsReturnType(line) &&
    !/\{/.test(line)
  ) {
    return null;
  }
  if (
    !unclosed &&
    !hasAccessOrVirtual(line) &&
    !hasTsReturnType(line) &&
    !/\{/.test(line) &&
    /\)\s*;\s*$/.test(line.trim())
  ) {
    return null;
  }
  return { name: ident.name, kind: "function" };
}

function leadingReturnType(span: string, name: string): string {
  const start = nameStartIndex(span, name);
  if (start < 0) return "";
  let before = span.slice(0, start).trim();
  const qual = before.lastIndexOf("::");
  if (qual >= 0) {
    before = before.slice(0, qual).replace(/~?[A-Za-z_]\w*\s*$/, "");
  }
  return stripLeadingModifiers(before);
}

export function isTsJsPath(path: string): boolean {
  return TS_JS_EXT.test(path.replace(/\\/g, "/"));
}

function isTypeContainer(kind: DocumentSymbolKind): boolean {
  return (
    kind === "class" ||
    kind === "interface" ||
    kind === "struct" ||
    kind === "enum"
  );
}

function braceDelta(s: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") break;
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

function tsTypeAfterColon(span: string): string {
  let depth = 0;
  let angle = 0;
  let quote: string | null = null;
  for (let i = 0; i < span.length; i++) {
    const ch = span[i]!;
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (
      depth <= 0 &&
      angle <= 0 &&
      (ch === "=" || ch === ";" || ch === ",")
    ) {
      return collapseWs(span.slice(0, i));
    }
  }
  return collapseWs(span);
}

function matchTsVar(line: string): LineHit | null {
  if (/^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+[{\[]/.test(line)) {
    return null;
  }
  const m = TS_VAR_RE.exec(line);
  if (!m) return null;
  return { name: m[1]!, kind: "variable" };
}

function matchTsField(line: string): (LineHit & { returnType?: string }) | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes("(") || trimmed.startsWith("...")) {
    return null;
  }
  const m = TS_FIELD_RE.exec(line);
  if (!m) return null;
  const name = m[1]!;
  if (
    CONTROL_NAMES.has(name) ||
    /^(?:class|interface|enum|type|namespace|function|const|let|var|import|export|extends|implements)$/.test(
      name,
    )
  ) {
    return null;
  }
  const hit: LineHit & { returnType?: string } = {
    name,
    kind: "variable",
  };
  const colon = trimmed.indexOf(":");
  const eq = trimmed.indexOf("=");
  if (colon >= 0 && (eq < 0 || colon < eq)) {
    const returnType = tsTypeAfterColon(trimmed.slice(colon + 1));
    if (returnType) hit.returnType = returnType;
  }
  return hit;
}

function matchTsLine(
  line: string,
  inTypeBody: boolean,
): (LineHit & { returnType?: string }) | null {
  const enumClass = ENUM_CLASS_RE.exec(line);
  if (enumClass) return { name: enumClass[1]!, kind: "enum" };

  const typeDecl = TYPE_DECL_RE.exec(line);
  if (typeDecl) {
    const kind = TYPE_KIND[typeDecl[1]!] ?? "class";
    return { name: typeDecl[2]!, kind };
  }

  if (/\bfunction\s+[A-Za-z_$]/.test(line)) {
    const m = FUNCTION_KW_RE.exec(line);
    if (m) return { name: m[1]!, kind: "function" };
  }

  const arrowField = ARROW_FIELD_RE.exec(line) ?? CONST_ARROW_RE.exec(line);
  if (arrowField) return { name: arrowField[1]!, kind: "function" };

  const modVar = matchTsVar(line);
  if (modVar) return modVar;

  if (!inTypeBody) return null;

  const ident = identBeforeParen(line);
  if (
    ident &&
    !CONTROL_NAMES.has(ident.name) &&
    !looksLikeCall(line, ident.index)
  ) {
    const unclosed = netOpenParens(line) > 0;
    const definitionShaped =
      hasAccessOrVirtual(line) ||
      hasTsReturnType(line) ||
      /\{/.test(line) ||
      ident.name === "constructor" ||
      /^(?:get|set)\s/.test(line.trim()) ||
      unclosed;
    if (definitionShaped) {
      return { name: ident.name, kind: "function" };
    }
  }

  return matchTsField(line);
}

function scanTsLike(text: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const typeBodies: number[] = [];
  const lines = text.split(/\r?\n/);
  let brace = 0;

  for (let i = 0; i < lines.length; i++) {
    if (symbols.length >= MAX_SYMBOLS) break;
    const line = lines[i]!;
    if (skipLine(line)) continue;

    while (
      typeBodies.length > 0 &&
      brace < typeBodies[typeBodies.length - 1]!
    ) {
      typeBodies.pop();
    }
    const inTypeBody =
      typeBodies.length > 0 && brace === typeBodies[typeBodies.length - 1]!;
    const allow = brace === 0 || inTypeBody;
    const hit = allow ? matchTsLine(line, inTypeBody) : null;

    if (hit) {
      const symbol: DocumentSymbol = {
        name: hit.name,
        kind: hit.kind,
        line: i + 1,
        depth: typeBodies.length,
      };
      if (hit.kind === "function") {
        const span = collectSpan(lines, i);
        const extra = signatureOf(
          span,
          hit.name,
          leadingReturnType(span, hit.name),
        );
        if (extra.params !== undefined) symbol.params = extra.params;
        if (extra.returnType) symbol.returnType = extra.returnType;
      } else if (hit.kind === "variable" && hit.returnType) {
        symbol.returnType = hit.returnType;
      }
      symbols.push(symbol);
    }

    if (hit && isTypeContainer(hit.kind) && !line.includes("{")) {
      let j = i + 1;
      while (j < lines.length && j - i < 8) {
        const look = lines[j]!;
        if (skipLine(look) && !look.includes("{")) {
          j += 1;
          continue;
        }
        brace += braceDelta(look);
        if (look.includes("{")) {
          typeBodies.push(brace);
          i = j;
          break;
        }
        if (look.includes(";")) break;
        j += 1;
      }
      continue;
    }

    const before = brace;
    brace += braceDelta(line);
    if (hit && isTypeContainer(hit.kind) && brace > before) {
      typeBodies.push(brace);
    }
    while (
      typeBodies.length > 0 &&
      brace < typeBodies[typeBodies.length - 1]!
    ) {
      typeBodies.pop();
    }
  }
  return symbols;
}

export function scanDocumentSymbols(
  text: string,
  options?: { path?: string; maxSymbols?: number },
): DocumentSymbol[] {
  const path = options?.path ?? "";
  if (path && isCppSourcePath(path)) return [];
  if (path && isCppHeaderPath(path)) {
    return scanCppHeader(text, options?.maxSymbols);
  }
  if (path && isTsJsPath(path)) return scanTsLike(text);
  return scanGeneric(text);
}

/** Kinds Quick Open indexes — types and functions, not fields or access rows. */
const QUICK_OPEN_KINDS = new Set<DocumentSymbolKind>([
  "class",
  "interface",
  "struct",
  "enum",
  "type",
  "function",
]);

export type QuickOpenSymbolHit = {
  name: string;
  kind: DocumentSymbolKind;
  line: number;
  container?: string;
};

/**
 * Workspace-symbol heads for Ctrl/Cmd+T. Same scanners as Outline, except
 * `.cpp` sources are indexed for `Class::Method` definitions (Outline skips
 * implementation files). Fields and `public`/`private` rows are omitted.
 */
export function scanQuickOpenSymbols(
  text: string,
  path: string,
): QuickOpenSymbolHit[] {
  const symbols = isCppSourcePath(path)
    ? scanDocumentSymbols(text)
    : scanDocumentSymbols(text, { path });
  const out: QuickOpenSymbolHit[] = [];
  const stack: string[] = [];
  for (const s of symbols) {
    while (stack.length > s.depth) stack.pop();
    if (QUICK_OPEN_KINDS.has(s.kind)) {
      const hit: QuickOpenSymbolHit = {
        name: s.name,
        kind: s.kind,
        line: s.line,
      };
      const container = stack[stack.length - 1];
      if (container) hit.container = container;
      out.push(hit);
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

function scanGeneric(text: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const typeStack: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (symbols.length >= MAX_SYMBOLS) break;
    const line = lines[i]!;
    if (skipLine(line)) continue;
    const hit = matchLine(line);
    if (!hit) continue;
    const indent = indentOf(line);
    while (
      typeStack.length > 0 &&
      indent <= typeStack[typeStack.length - 1]!
    ) {
      typeStack.pop();
    }
    const depth = typeStack.length;
    const symbol: DocumentSymbol = {
      name: hit.name,
      kind: hit.kind,
      line: i + 1,
      depth,
    };
    if (hit.kind === "function") {
      const span = collectSpan(lines, i);
      const extra = signatureOf(
        span,
        hit.name,
        leadingReturnType(span, hit.name),
      );
      if (extra.params !== undefined) symbol.params = extra.params;
      if (extra.returnType) symbol.returnType = extra.returnType;
    }
    symbols.push(symbol);
    if (hit.kind !== "function") typeStack.push(indent);
  }
  return symbols;
}

/** Last symbol whose line is at or before `line` (innermost in source order). */
export function symbolIndexAtLine(
  symbols: readonly DocumentSymbol[],
  line: number,
): number {
  let best = -1;
  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i]!.line <= line) best = i;
    else break;
  }
  return best;
}

/** Outline label suffix: `(params): Return` or `: Type` for fields. */
export function outlineSignatureText(symbol: {
  kind: DocumentSymbolKind;
  params?: string;
  returnType?: string;
}): string {
  if (symbol.kind === "access" || symbol.kind === "class" || symbol.kind === "struct" || symbol.kind === "enum" || symbol.kind === "interface" || symbol.kind === "type") {
    return "";
  }
  if (symbol.kind === "variable") {
    return symbol.returnType ? `: ${symbol.returnType}` : "";
  }
  const params = symbol.params ?? "";
  const ret = symbol.returnType ? `: ${symbol.returnType}` : "";
  return `(${params})${ret}`;
}
