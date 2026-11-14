/**
 * Phase 1 local/parameter binding parser for C++ (Unreal-style sources).
 *
 * Pure and browser-free: given a caret in a buffer, resolve the selected
 * identifier to the nearest parameter or local declaration in the enclosing
 * function. F12 and Find Usages consume the returned declaration, type, and
 * lexical/function ranges.
 *
 * Deliberate skips: `auto`, structured bindings, comma multi-declarations,
 * macro-like statements, function pointers, and other unsupported forms.
 * Reuses comment/brace/impl-head helpers from cppContainerContext / cppSymbolIndex.
 */

import {
  classifyBlockHead,
  stripTemplateArgs,
} from "./cppContainerContext.js";
import { scanCppImplLine } from "./cppSymbolIndex.js";

export type CppLocalBindingKind = "parameter" | "local";

/** 1-based inclusive source range. */
export type CppTextRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type CppLocalBinding = {
  kind: CppLocalBindingKind;
  name: string;
  /** Explicit type as written (`const FString&`, `TArray<int32>`, `AActor*`). */
  type: string;
  /** Type recovered from a high-confidence initializer pattern. */
  inferredType?: string;
  /** Initializer call used for symbol-table return-type inference. */
  initializerCall?: { name: string; qualifier?: string };
  /** Sanitized initializer/range expression for lightweight inference. */
  initializerExpression?: string;
  /** Range source for `for (auto X : Source)`. */
  rangeExpression?: string;
  /** 1-based line of the declared name. */
  declarationLine: number;
  /** 1-based column of the declared name. */
  declarationColumn: number;
  /** Region where the name is visible (for later usage matching). */
  scope: CppTextRange;
  /** Enclosing function signature through its closing `}`. */
  functionRange: CppTextRange;
};

const MAX_FUNCTION_CHARS = 200_000;
const MAX_OUTWARD_HOPS = 32;

const CONTROL_HEADS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "else",
  "do",
  "try",
]);

const STMT_SKIP = new Set([
  "return",
  "co_return",
  "co_await",
  "co_yield",
  "break",
  "continue",
  "goto",
  "throw",
  "static_assert",
  "using",
  "typedef",
  "namespace",
  "template",
  "case",
  "default",
  "asm",
  "static_cast",
  "dynamic_cast",
  "reinterpret_cast",
  "const_cast",
  "sizeof",
  "alignof",
  "new",
  "delete",
]);

const TYPE_SPEC = new Set([
  "const",
  "volatile",
  "mutable",
  "constexpr",
  "consteval",
  "constinit",
  "static",
  "register",
  "extern",
  "inline",
  "virtual",
  "friend",
  "thread_local",
  "typename",
  "struct",
  "class",
  "enum",
  "union",
  "unsigned",
  "signed",
  "short",
  "long",
  "void",
  "bool",
  "char",
  "int",
  "float",
  "double",
  "wchar_t",
  "char8_t",
  "char16_t",
  "char32_t",
]);

const IDENT_RE = /[A-Za-z_]\w*/;

export function resolveCppLocalBinding(
  text: string,
  line: number,
  column: number,
): CppLocalBinding | null {
  if (!text || line < 1 || column < 1) return null;
  const ident = cppIdentifierAt(text, line, column);
  if (!ident) return null;
  if (CONTROL_HEADS.has(ident.name) || STMT_SKIP.has(ident.name)) return null;
  if (isQualifiedName(text, ident.start) || isMemberName(text, ident.start)) {
    return null;
  }

  const code = sanitizeCpp(text);
  const fn = findEnclosingFunction(code, ident.start);
  if (!fn) return null;
  if (fn.bodyClose - fn.sigStart > MAX_FUNCTION_CHARS) return null;

  const bindings: CppLocalBinding[] = [];
  collectParameters(text, code, fn, bindings);
  collectLocals(text, code, fn, bindings);

  let best: CppLocalBinding | null = null;
  let bestDecl = -1;
  for (const b of bindings) {
    if (b.name !== ident.name) continue;
    const decl = offsetAt(text, b.declarationLine, b.declarationColumn);
    if (decl < 0 || ident.start < decl) continue;
    if (!rangeContains(text, b.scope, ident.start)) continue;
    if (decl >= bestDecl) {
      best = b;
      bestDecl = decl;
    }
  }
  return best;
}

export function cppIdentifierAt(
  text: string,
  line: number,
  column: number,
): { name: string; start: number; end: number } | null {
  const offset = offsetAt(text, line, column);
  if (offset < 0) return null;
  let i = Math.min(offset, text.length);
  if (i === text.length) i -= 1;
  if (i < 0) return null;
  if (!isIdentChar(text[i]!) && i > 0 && isIdentChar(text[i - 1]!)) i -= 1;
  if (!isIdentChar(text[i]!)) return null;
  let start = i;
  while (start > 0 && isIdentChar(text[start - 1]!)) start -= 1;
  let end = i + 1;
  while (end < text.length && isIdentChar(text[end]!)) end += 1;
  const name = text.slice(start, end);
  if (!IDENT_RE.test(name) || /^\d/.test(name)) return null;
  return { name, start, end };
}

// -------------------------------------------------- sanitize / positions

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

/** Same length as `text`; comments, strings, and `#` lines become spaces. */
function sanitizeCpp(text: string): string {
  const out = new Array<string>(text.length);
  let i = 0;
  let lineStart = true;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n") {
      out[i] = ch;
      i += 1;
      lineStart = true;
      continue;
    }
    if (lineStart && (ch === " " || ch === "\t" || ch === "\r")) {
      out[i] = ch;
      i += 1;
      continue;
    }
    if (lineStart && ch === "#") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      lineStart = false;
      continue;
    }
    lineStart = false;
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < text.length) {
        if (text[i] === "\n") {
          out[i] = "\n";
          i += 1;
          continue;
        }
        if (text[i] === "*" && text[i + 1] === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          break;
        }
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (ch === "R" && text[i + 1] === '"') {
      const raw = consumeRawString(text, i, out);
      if (raw > i) {
        i = raw;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      out[i] = " ";
      i += 1;
      while (i < text.length && text[i] !== "\n") {
        if (text[i] === "\\") {
          out[i] = " ";
          if (i + 1 < text.length && text[i + 1] !== "\n") {
            out[i + 1] = " ";
            i += 2;
            continue;
          }
          i += 1;
          continue;
        }
        if (text[i] === ch) {
          out[i] = " ";
          i += 1;
          break;
        }
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join("");
}

function consumeRawString(
  text: string,
  start: number,
  out: string[],
): number {
  // R"delim( ... )delim"
  let i = start + 2;
  let delim = "";
  while (i < text.length && text[i] !== "(" && text[i] !== "\n") {
    delim += text[i];
    i += 1;
  }
  if (text[i] !== "(") return start;
  const close = `)${delim}"`;
  const bodyStart = i + 1;
  const found = text.indexOf(close, bodyStart);
  if (found < 0) return start;
  for (let k = start; k < found + close.length; k++) {
    out[k] = text[k] === "\n" ? "\n" : " ";
  }
  return found + close.length;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetAt(text: string, line: number, column: number): number {
  const starts = lineStartsOf(text);
  const start = starts[line - 1];
  if (start === undefined) return -1;
  const next = starts[line] ?? text.length;
  const maxCol = next - start + 1;
  if (column < 1 || column > maxCol + 1) {
    if (column < 1) return -1;
  }
  return Math.min(start + column - 1, next);
}

function posAt(
  text: string,
  offset: number,
): { line: number; column: number } {
  const starts = lineStartsOf(text);
  let line = 1;
  for (let i = 1; i < starts.length; i++) {
    if (starts[i]! <= offset) line = i + 1;
    else break;
  }
  const start = starts[line - 1] ?? 0;
  return { line, column: offset - start + 1 };
}

function rangeOf(text: string, start: number, endInclusive: number): CppTextRange {
  const a = posAt(text, Math.max(0, start));
  const b = posAt(text, Math.min(text.length - 1, Math.max(start, endInclusive)));
  return {
    startLine: a.line,
    startColumn: a.column,
    endLine: b.line,
    endColumn: b.column,
  };
}

function rangeContains(
  text: string,
  range: CppTextRange,
  offset: number,
): boolean {
  const start = offsetAt(text, range.startLine, range.startColumn);
  const end = offsetAt(text, range.endLine, range.endColumn);
  if (start < 0 || end < 0) return false;
  return offset >= start && offset <= end;
}

function isQualifiedName(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /[ \t]/.test(text[i]!)) i -= 1;
  return i >= 1 && text[i] === ":" && text[i - 1] === ":";
}

function isMemberName(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /[ \t]/.test(text[i]!)) i -= 1;
  if (i < 0) return false;
  if (text[i] === ".") return true;
  if (text[i] === ">" && i >= 1 && text[i - 1] === "-") return true;
  return false;
}

// -------------------------------------------------- function enclosure

type FunctionSpan = {
  sigStart: number;
  paramOpen: number;
  paramClose: number;
  bodyOpen: number;
  bodyClose: number;
};

function findEnclosingFunction(
  code: string,
  offset: number,
): FunctionSpan | null {
  let searchFrom = offset;
  for (let hop = 0; hop < MAX_OUTWARD_HOPS; hop++) {
    const open = findUnmatchedOpenBrace(code, searchFrom);
    if (open < 0) break;
    const fn = functionAtBodyBrace(code, open);
    if (fn && offset >= fn.sigStart && offset <= fn.bodyClose) return fn;
    searchFrom = open;
  }
  const forward = functionFromForwardBrace(code, offset);
  if (forward && offset >= forward.sigStart && offset <= forward.bodyClose) {
    return forward;
  }
  return null;
}

function findUnmatchedOpenBrace(code: string, from: number): number {
  let depth = 0;
  for (let i = from - 1; i >= 0; i--) {
    const ch = code[i]!;
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function matchPair(
  code: string,
  openIndex: number,
  openCh: string,
  closeCh: string,
): number {
  if (code[openIndex] !== openCh) return -1;
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function functionAtBodyBrace(
  code: string,
  bodyOpen: number,
): FunctionSpan | null {
  const parens = paramParensBeforeBody(code, bodyOpen);
  if (!parens) return null;
  const head = collapseWs(code.slice(parens.sigStart, bodyOpen));
  if (!isFunctionHead(head)) return null;
  const bodyClose = matchPair(code, bodyOpen, "{", "}");
  if (bodyClose < 0) return null;
  return {
    sigStart: parens.sigStart,
    paramOpen: parens.paramOpen,
    paramClose: parens.paramClose,
    bodyOpen,
    bodyClose,
  };
}

function unmatchedDepth(code: string, offset: number, open: string, close: string): number {
  let depth = 0;
  const lim = Math.min(offset, code.length);
  for (let i = 0; i < lim; i++) {
    const ch = code[i]!;
    if (ch === open) depth += 1;
    else if (ch === close) depth -= 1;
  }
  return depth;
}

function functionFromForwardBrace(
  code: string,
  offset: number,
): FunctionSpan | null {
  let paren = unmatchedDepth(code, offset, "(", ")");
  let brace = unmatchedDepth(code, offset, "{", "}");
  const limit = Math.min(code.length, offset + 4000);
  for (let i = offset; i < limit; i++) {
    const ch = code[i]!;
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "{") {
      if (paren === 0) {
        const fn = functionAtBodyBrace(code, i);
        if (fn) return fn;
      }
      brace += 1;
    } else if (ch === "}") {
      brace -= 1;
      if (brace < 0) return null;
    }
  }
  return null;
}

function paramParensBeforeBody(
  code: string,
  bodyOpen: number,
): { sigStart: number; paramOpen: number; paramClose: number } | null {
  let i = skipWsLeft(code, bodyOpen - 1);
  // Trailing qualifiers + ctor-initializer list, then the parameter `)`.
  for (let n = 0; n < 24 && i >= 0; n++) {
    if (code[i] === ")") {
      const open = matchLeft(code, i, "(", ")");
      if (open < 0) return null;
      const before = skipWsLeft(code, open - 1);
      const ident = readIdentLeft(code, before);
      if (
        ident &&
        (ident.name === "noexcept" ||
          ident.name === "throw" ||
          ident.name === "alignas" ||
          ident.name === "requires")
      ) {
        i = skipWsLeft(code, ident.start - 1);
        continue;
      }
      // Ctor-init: `Ident(args)` after `:` or `,` — never a `::` qualifier.
      const afterIdent = ident ? skipWsLeft(code, ident.start - 1) : before;
      const ctorColon =
        code[afterIdent] === ":" &&
        afterIdent >= 1 &&
        code[afterIdent - 1] !== ":";
      if (code[afterIdent] === "," || ctorColon) {
        i = skipWsLeft(code, afterIdent - 1);
        continue;
      }
      // This `)` closes the parameter list.
      const nameEnd = skipWsLeft(code, open - 1);
      if (nameEnd < 0 || !isIdentChar(code[nameEnd]!)) return null;
      const name = readIdentLeft(code, nameEnd);
      if (!name) return null;
      const sigStart = signatureStart(code, name.start);
      return { sigStart, paramOpen: open, paramClose: i };
    }
    if (isIdentStart(code[i]!)) {
      const ident = readIdentLeft(code, i);
      if (
        ident &&
        /^(?:const|volatile|override|final|noexcept|mutable|constexpr)$/.test(
          ident.name,
        )
      ) {
        i = skipWsLeft(code, ident.start - 1);
        continue;
      }
      return null;
    }
    if (code[i] === ">" ) {
      // trailing return `-> Type`
      const lt = matchLeft(code, i, "<", ">");
      i = skipWsLeft(code, (lt >= 0 ? lt : i) - 1);
      continue;
    }
    if (code[i] === "-" && code[i + 1] === ">") {
      i = skipWsLeft(code, i - 1);
      continue;
    }
    return null;
  }
  return null;
}

function signatureStart(code: string, nameStart: number): number {
  let i = nameStart;
  // Include `Class::` / `ns::Class::` and `~`.
  while (true) {
    const left = skipWsLeft(code, i - 1);
    if (left >= 1 && code[left] === ":" && code[left - 1] === ":") {
      const prev = skipWsLeft(code, left - 2);
      const ident = readIdentLeft(code, prev);
      if (!ident) break;
      i = ident.start;
      continue;
    }
    if (code[left] === "~") {
      i = left;
      continue;
    }
    break;
  }
  // Return type / specifiers on this and previous lines.
  let guard = 0;
  while (guard++ < 40) {
    const left = skipWsLeft(code, i - 1);
    if (left < 0) {
      i = 0;
      break;
    }
    if (code[left] === ";" || code[left] === "{" || code[left] === "}") break;
    if (code[left] === ">" ) {
      const lt = matchLeft(code, left, "<", ">");
      if (lt < 0) break;
      i = lt;
      continue;
    }
    if (code[left] === "*" || code[left] === "&") {
      i = left;
      continue;
    }
    if (isIdentChar(code[left]!)) {
      const ident = readIdentLeft(code, left);
      if (!ident) break;
      i = ident.start;
      continue;
    }
    break;
  }
  // Snap to line start, then include a preceding `template<...>`.
  while (i > 0 && code[i - 1] !== "\n") i -= 1;
  const prevLineEnd = skipWsLeft(code, i - 1);
  if (prevLineEnd >= 0) {
    let p = prevLineEnd;
    while (p > 0 && code[p] !== "\n") p -= 1;
    if (code[p] === "\n") p += 1;
    const prev = collapseWs(code.slice(p, i));
    if (/^template\s*</.test(prev)) i = p;
  }
  return i;
}

function isFunctionHead(head: string): boolean {
  const text = collapseWs(head);
  if (!text || text.length > 1200) return false;
  const stripped = text.includes("<") ? stripTemplateArgs(text) : text;
  if (/^(?:if|for|while|switch|catch|else|do|try)\b/.test(stripped)) {
    return false;
  }
  if (/^(?:namespace|class|struct|enum|union)\b/.test(stripped)) return false;
  if (classifyBlockHead(stripped)?.source === "type-body") return false;
  if (scanCppImplLine(stripped)) return true;
  if (/\]\s*(?:\(|\{)/.test(stripped)) return false; // lambda
  const m =
    /(?:^|[^\w])(~?[A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?(?:noexcept\b.*)?(?::.*)?$/.exec(
      stripped,
    );
  if (!m) return false;
  const name = m[1]!;
  if (CONTROL_HEADS.has(name) || STMT_SKIP.has(name)) return false;
  return true;
}

function matchLeft(
  code: string,
  closeIndex: number,
  openCh: string,
  closeCh: string,
): number {
  if (code[closeIndex] !== closeCh) return -1;
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    const ch = code[i]!;
    if (ch === closeCh) depth += 1;
    else if (ch === openCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipWsLeft(code: string, i: number): number {
  let k = i;
  while (k >= 0 && /[ \t\r\n]/.test(code[k]!)) k -= 1;
  return k;
}

function skipWsRight(code: string, i: number, limit: number): number {
  let k = i;
  while (k < limit && /[ \t\r\n]/.test(code[k]!)) k += 1;
  return k;
}

function readIdentLeft(
  code: string,
  end: number,
): { name: string; start: number; end: number } | null {
  if (end < 0 || !isIdentChar(code[end]!)) return null;
  let start = end;
  while (start > 0 && isIdentChar(code[start - 1]!)) start -= 1;
  if (!isIdentStart(code[start]!)) return null;
  return { name: code.slice(start, end + 1), start, end: end + 1 };
}

function readIdentRight(
  code: string,
  start: number,
  limit: number,
): { name: string; start: number; end: number } | null {
  if (start >= limit || !isIdentStart(code[start]!)) return null;
  let end = start + 1;
  while (end < limit && isIdentChar(code[end]!)) end += 1;
  return { name: code.slice(start, end), start, end };
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// -------------------------------------------------- parameters

function collectParameters(
  text: string,
  code: string,
  fn: FunctionSpan,
  out: CppLocalBinding[],
): void {
  const inner = code.slice(fn.paramOpen + 1, fn.paramClose);
  if (!inner.trim() || /^void$/i.test(inner.trim())) return;
  const parts = splitTopLevel(code, fn.paramOpen + 1, fn.paramClose, ",");
  const functionRange = rangeOf(text, fn.sigStart, fn.bodyClose);
  for (const part of parts) {
    const parsed = parseNamedDecl(code, part.start, part.end, { allowInit: true });
    if (!parsed) continue;
    out.push({
      kind: "parameter",
      name: parsed.name,
      type: parsed.type,
      ...(parsed.inferredType ? { inferredType: parsed.inferredType } : {}),
      ...(parsed.initializerCall
        ? { initializerCall: parsed.initializerCall }
        : {}),
      ...(parsed.initializerExpression
        ? { initializerExpression: parsed.initializerExpression }
        : {}),
      declarationLine: posAt(text, parsed.nameStart).line,
      declarationColumn: posAt(text, parsed.nameStart).column,
      scope: functionRange,
      functionRange,
    });
  }
}

type Span = { start: number; end: number };

function splitTopLevel(
  code: string,
  from: number,
  to: number,
  sep: string,
): Span[] {
  const parts: Span[] = [];
  let start = from;
  let paren = 0;
  let angle = 0;
  let square = 0;
  for (let i = from; i < to; i++) {
    const ch = code[i]!;
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "[") square += 1;
    else if (ch === "]") square -= 1;
    else if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (
      ch === sep &&
      paren === 0 &&
      angle === 0 &&
      square === 0
    ) {
      parts.push({ start, end: i });
      start = i + 1;
    }
  }
  parts.push({ start, end: to });
  return parts;
}

// -------------------------------------------------- locals

function collectLocals(
  text: string,
  code: string,
  fn: FunctionSpan,
  out: CppLocalBinding[],
): void {
  const functionRange = rangeOf(text, fn.sigStart, fn.bodyClose);
  scanBlock(
    text,
    code,
    fn.bodyOpen + 1,
    fn.bodyClose,
    fn.bodyOpen,
    fn.bodyClose,
    functionRange,
    out,
  );
}

function scanBlock(
  text: string,
  code: string,
  from: number,
  to: number,
  blockOpen: number,
  blockClose: number,
  functionRange: CppTextRange,
  out: CppLocalBinding[],
): void {
  let i = from;
  while (i < to) {
    i = skipWsRight(code, i, to);
    if (i >= to) break;
    const ch = code[i]!;
    if (ch === "{") {
      const close = matchPair(code, i, "{", "}");
      if (close < 0 || close > to) break;
      scanBlock(text, code, i + 1, close, i, close, functionRange, out);
      i = close + 1;
      continue;
    }
    if (ch === "}") break;
    const ident = readIdentRight(code, i, to);
    if (!ident) {
      i += 1;
      continue;
    }
    if (ident.name === "if") {
      i = scanIf(text, code, ident.start, to, functionRange, out);
      continue;
    }
    if (ident.name === "for") {
      i = scanFor(text, code, ident.start, to, functionRange, out);
      continue;
    }
    if (ident.name === "while" || ident.name === "switch") {
      i = scanParenStmt(text, code, ident.start, to, functionRange, out);
      continue;
    }
    if (ident.name === "else" || ident.name === "do" || ident.name === "try") {
      i = ident.end;
      continue;
    }
    if (ident.name === "catch") {
      i = scanParenStmt(text, code, ident.start, to, functionRange, out);
      continue;
    }
    if (STMT_SKIP.has(ident.name) || CONTROL_HEADS.has(ident.name)) {
      i = skipStatement(code, ident.start, to);
      continue;
    }
    if (
      ident.name === "class" ||
      ident.name === "struct" ||
      ident.name === "enum" ||
      ident.name === "union" ||
      ident.name === "namespace"
    ) {
      i = skipStatement(code, ident.start, to);
      continue;
    }
    const stmtEnd = statementEnd(code, ident.start, to);
    if (stmtEnd < 0) break;
    tryLocalDecl(
      text,
      code,
      ident.start,
      stmtEnd,
      blockOpen,
      blockClose,
      functionRange,
      out,
    );
    i = stmtEnd + 1;
  }
}

function scanIf(
  text: string,
  code: string,
  start: number,
  limit: number,
  functionRange: CppTextRange,
  out: CppLocalBinding[],
): number {
  const header = controlHeader(code, start, limit);
  if (!header) return start + 2;
  const bodyEnd = scanControlBody(code, header.close + 1, limit);
  let scopeEnd = bodyEnd;
  const after = skipWsRight(code, bodyEnd, limit);
  const elseIdent = readIdentRight(code, after, limit);
  if (elseIdent?.name === "else") {
    scopeEnd = scanControlBody(code, elseIdent.end, limit);
  }
  bindControlInit(
    text,
    code,
    header.open + 1,
    header.close,
    start,
    scopeEnd - 1,
    functionRange,
    out,
  );
  return scopeEnd;
}

function scanFor(
  text: string,
  code: string,
  start: number,
  limit: number,
  functionRange: CppTextRange,
  out: CppLocalBinding[],
): number {
  const header = controlHeader(code, start, limit);
  if (!header) return start + 3;
  const bodyEnd = scanControlBody(code, header.close + 1, limit);
  bindControlInit(
    text,
    code,
    header.open + 1,
    header.close,
    start,
    bodyEnd - 1,
    functionRange,
    out,
  );
  return bodyEnd;
}

function scanParenStmt(
  text: string,
  code: string,
  start: number,
  limit: number,
  functionRange: CppTextRange,
  out: CppLocalBinding[],
): number {
  const header = controlHeader(code, start, limit);
  if (!header) return start + 1;
  const bodyEnd = scanControlBody(code, header.close + 1, limit);
  bindControlInit(
    text,
    code,
    header.open + 1,
    header.close,
    start,
    bodyEnd - 1,
    functionRange,
    out,
  );
  return bodyEnd;
}

function controlHeader(
  code: string,
  kwStart: number,
  limit: number,
): { open: number; close: number } | null {
  const ident = readIdentRight(code, kwStart, limit);
  if (!ident) return null;
  const open = skipWsRight(code, ident.end, limit);
  if (code[open] !== "(") return null;
  const close = matchPair(code, open, "(", ")");
  if (close < 0 || close >= limit) return null;
  return { open, close };
}

function scanControlBody(code: string, from: number, limit: number): number {
  const i = skipWsRight(code, from, limit);
  if (i >= limit) return limit;
  if (code[i] === "{") {
    const close = matchPair(code, i, "{", "}");
    return close < 0 ? limit : close + 1;
  }
  return skipStatement(code, i, limit);
}

function skipStatement(code: string, from: number, limit: number): number {
  let i = skipWsRight(code, from, limit);
  const ident = readIdentRight(code, i, limit);
  if (
    ident &&
    (ident.name === "if" ||
      ident.name === "for" ||
      ident.name === "while" ||
      ident.name === "switch")
  ) {
    const header = controlHeader(code, ident.start, limit);
    if (!header) return Math.min(ident.end, limit);
    return scanControlBody(code, header.close + 1, limit);
  }
  let paren = 0;
  let brace = 0;
  for (; i < limit; i++) {
    const ch = code[i]!;
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}") {
      if (brace === 0) return i;
      brace -= 1;
    } else if (ch === ";" && paren === 0 && brace === 0) {
      return i + 1;
    }
  }
  return limit;
}

function statementEnd(code: string, from: number, limit: number): number {
  let paren = 0;
  let brace = 0;
  let angle = 0;
  for (let i = from; i < limit; i++) {
    const ch = code[i]!;
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === "{") {
      if (paren === 0 && angle === 0 && brace === 0) {
        // Brace-init `T Name{…};` vs a nested block. Look ahead after `}`.
        const close = matchPair(code, i, "{", "}");
        if (close < 0) return -1;
        const after = skipWsRight(code, close + 1, limit);
        if (code[after] === ";") return after;
        // Nested type / unsupported block: skip whole brace.
        return close;
      }
      brace += 1;
    } else if (ch === "}") {
      if (brace === 0) return i;
      brace -= 1;
    } else if (ch === ";" && paren === 0 && brace === 0 && angle === 0) {
      return i;
    }
  }
  return -1;
}

function bindControlInit(
  text: string,
  code: string,
  innerStart: number,
  innerEnd: number,
  scopeStart: number,
  scopeEnd: number,
  functionRange: CppTextRange,
  out: CppLocalBinding[],
): void {
  const rangeFor = rangeOf(text, scopeStart, Math.max(scopeStart, scopeEnd));
  // Classic for: first clause. Range-for: left of `:`. If-init: first `;` or whole.
  const colon = topLevelIndex(code, innerStart, innerEnd, ":");
  if (colon >= 0 && code[colon + 1] !== ":") {
    pushLocal(
      text,
      code,
      innerStart,
      colon,
      rangeFor,
      functionRange,
      out,
      false,
      collapseWs(code.slice(colon + 1, innerEnd)),
    );
    return;
  }
  const semi = topLevelIndex(code, innerStart, innerEnd, ";");
  if (semi >= 0) {
    pushLocal(
      text,
      code,
      innerStart,
      semi,
      rangeFor,
      functionRange,
      out,
      false,
    );
    return;
  }
  pushLocal(
    text,
    code,
    innerStart,
    innerEnd,
    rangeFor,
    functionRange,
    out,
    false,
  );
}

function topLevelIndex(
  code: string,
  from: number,
  to: number,
  sep: string,
): number {
  let paren = 0;
  let angle = 0;
  for (let i = from; i < to; i++) {
    const ch = code[i]!;
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === sep && paren === 0 && angle === 0) {
      if (sep === ":" && code[i + 1] === ":") continue;
      return i;
    }
  }
  return -1;
}

function tryLocalDecl(
  text: string,
  code: string,
  from: number,
  stmtEnd: number,
  blockOpen: number,
  blockClose: number,
  functionRange: CppTextRange,
  out: CppLocalBinding[],
): void {
  const scope = rangeOf(text, blockOpen, blockClose);
  pushLocal(text, code, from, stmtEnd, scope, functionRange, out, true);
}

function pushLocal(
  text: string,
  code: string,
  from: number,
  to: number,
  scope: CppTextRange,
  functionRange: CppTextRange,
  out: CppLocalBinding[],
  rejectComma: boolean,
  rangeExpression?: string,
): void {
  if (rejectComma && hasTopLevelComma(code, from, to)) return;
  if (looksLikeMacroCall(code, from, to)) return;
  const parsed = parseNamedDecl(code, from, to, { allowInit: true });
  if (!parsed) return;
  out.push({
    kind: "local",
    name: parsed.name,
    type: parsed.type,
    ...(parsed.inferredType ? { inferredType: parsed.inferredType } : {}),
    ...(parsed.initializerCall
      ? { initializerCall: parsed.initializerCall }
      : {}),
    ...(parsed.initializerExpression
      ? { initializerExpression: parsed.initializerExpression }
      : {}),
    ...(rangeExpression ? { rangeExpression } : {}),
    declarationLine: posAt(text, parsed.nameStart).line,
    declarationColumn: posAt(text, parsed.nameStart).column,
    scope,
    functionRange,
  });
}

function hasTopLevelComma(code: string, from: number, to: number): boolean {
  let paren = 0;
  let angle = 0;
  let square = 0;
  let brace = 0;
  for (let i = from; i < to; i++) {
    const ch = code[i]!;
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === "[") square += 1;
    else if (ch === "]") square -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
    else if (
      ch === "," &&
      paren === 0 &&
      angle === 0 &&
      square === 0 &&
      brace === 0
    ) {
      return true;
    }
  }
  return false;
}

function looksLikeMacroCall(code: string, from: number, to: number): boolean {
  const ident = readIdentRight(code, skipWsRight(code, from, to), to);
  if (!ident) return false;
  if (!/^[A-Z][A-Z0-9_]+$/.test(ident.name) || ident.name.length < 3) {
    return false;
  }
  const after = skipWsRight(code, ident.end, to);
  return code[after] === "(";
}

type ParsedDecl = {
  name: string;
  type: string;
  nameStart: number;
  inferredType?: string;
  initializerCall?: { name: string; qualifier?: string };
  initializerExpression?: string;
};

function parseNamedDecl(
  code: string,
  from: number,
  to: number,
  _opts: { allowInit: boolean },
): ParsedDecl | null {
  const start = skipWsRight(code, from, to);
  let end = to;
  while (end > start && /[ \t\r\n;]/.test(code[end - 1]!)) end -= 1;
  if (start >= end) return null;

  const slice = code.slice(start, end);
  if (/\bdecltype\s*\(/.test(slice)) return null;
  if (/\[/.test(slice) && /\]/.test(slice) && /\bauto\b/.test(slice)) {
    return null;
  }
  // Structured binding: `[a, b]` after optional ref/ampersand, no `auto` already skipped.
  if (/^\s*(?:const\s+)?(?:volatile\s+)?(?:&&|&)?\s*\[/.test(slice)) return null;
  if (slice.includes("[" ) && /^\s*\[/.test(collapseWs(slice).replace(/^(?:const|volatile|&|&&)*/, ""))) {
    return null;
  }

  const tokens = tokenizeDecl(code, start, end);
  if (!tokens) return null;
  const { nameToken, typeEnd } = tokens;
  if (!nameToken) return null;
  const type = collapseWs(code.slice(start, typeEnd));
  if (!type || type === nameToken.name) return null;
  const initializer = initializerText(code, nameToken.end, end);
  const inferredType = inferAutoInitializerType(type, initializer);
  const initializerCall = parseInitializerCall(initializer);
  return {
    name: nameToken.name,
    type,
    nameStart: nameToken.start,
    ...(inferredType ? { inferredType } : {}),
    ...(initializerCall ? { initializerCall } : {}),
    ...(initializer ? { initializerExpression: initializer } : {}),
  };
}

function initializerText(code: string, from: number, to: number): string {
  const eq = topLevelIndex(code, from, to, "=");
  if (eq < 0) return "";
  return collapseWs(code.slice(eq + 1, to).replace(/;\s*$/, ""));
}

function inferAutoInitializerType(
  writtenType: string,
  initializer: string,
): string | null {
  if (!/\bauto\b/.test(writtenType) || !initializer) return null;
  const explicit =
    /\b(?:Cast|CastChecked|ExactCast|ExactCastChecked)\s*<\s*([A-Za-z_]\w*(?:::\w+)*)\s*>/.exec(
      initializer,
    ) ??
    /\b(?:GetPlayerState|GetPawn|FindComponentByClass)\s*<\s*([A-Za-z_]\w*(?:::\w+)*)\s*>/.exec(
      initializer,
    );
  if (!explicit?.[1]) return null;
  return `${explicit[1]}*`;
}

function parseInitializerCall(
  initializer: string,
): { name: string; qualifier?: string } | null {
  if (!initializer) return null;
  const matches = [
    ...initializer.matchAll(
      /(?:(\b[A-Za-z_]\w*(?:::\w+)*|\b[A-Za-z_]\w*)\s*(?:::|->|\.)\s*)?([A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*\(/g,
    ),
  ];
  const match = matches[matches.length - 1];
  if (!match?.[2]) return null;
  const qualifier = match[1]?.split("::").pop();
  return qualifier ? { name: match[2], qualifier } : { name: match[2] };
}

function tokenizeDecl(
  code: string,
  from: number,
  to: number,
): {
  nameToken: { name: string; start: number; end: number };
  typeEnd: number;
} | null {
  type Tok =
    | { kind: "ident"; name: string; start: number; end: number }
    | { kind: "punct"; ch: string; start: number; end: number };
  const toks: Tok[] = [];
  let i = from;
  let paren = 0;
  let angle = 0;
  let square = 0;
  while (i < to) {
    i = skipWsRight(code, i, to);
    if (i >= to) break;
    const ch = code[i]!;
    if (ch === "=" && paren === 0 && angle === 0 && square === 0) break;
    if (ch === ":" && code[i + 1] !== ":" && paren === 0 && angle === 0) break;
    if (ch === ";" && paren === 0 && angle === 0) break;
    if (ch === "," && paren === 0 && angle === 0 && square === 0) break;
    if (isIdentStart(ch)) {
      const ident = readIdentRight(code, i, to);
      if (!ident) return null;
      toks.push({
        kind: "ident",
        name: ident.name,
        start: ident.start,
        end: ident.end,
      });
      i = ident.end;
      continue;
    }
    if (ch === "(") {
      if (paren === 0 && angle === 0 && square === 0) {
        // Ctor-init after the name: stop. Function-pointer: `(` before name.
        const hasName = toks.some((t) => t.kind === "ident" && !TYPE_SPEC.has(t.name));
        if (hasName) break;
        return null;
      }
      paren += 1;
      toks.push({ kind: "punct", ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ")") {
      paren -= 1;
      toks.push({ kind: "punct", ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === "<") {
      angle += 1;
      toks.push({ kind: "punct", ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ">") {
      if (angle > 0) angle -= 1;
      toks.push({ kind: "punct", ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === "[") {
      square += 1;
      i += 1;
      continue;
    }
    if (ch === "]") {
      square -= 1;
      i += 1;
      continue;
    }
    if (ch === "{" && paren === 0 && angle === 0) break;
    if ((ch === "*" || ch === "&") && square === 0) {
      const end = ch === "&" && code[i + 1] === "&" ? i + 2 : i + 1;
      toks.push({ kind: "punct", ch: code.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    if (ch === ":" && code[i + 1] === ":") {
      toks.push({ kind: "punct", ch: "::", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (ch === ".") return null;
    i += 1;
  }
  if (paren !== 0 || angle !== 0) return null;

  const depth0Idents: { name: string; start: number; end: number }[] = [];
  let dParen = 0;
  let dAngle = 0;
  for (const t of toks) {
    if (t.kind === "punct") {
      if (t.ch === "(") dParen += 1;
      else if (t.ch === ")") dParen -= 1;
      else if (t.ch === "<") dAngle += 1;
      else if (t.ch === ">") dAngle -= 1;
      continue;
    }
    if (dParen === 0 && dAngle === 0) depth0Idents.push(t);
  }
  const nameCandidates = depth0Idents.filter((t) => !TYPE_SPEC.has(t.name));
  if (nameCandidates.length === 0) return null;
  const nameToken = nameCandidates[nameCandidates.length - 1]!;
  const prior = nameCandidates.length - 1;
  const hasSpec = depth0Idents.some((t) => TYPE_SPEC.has(t.name) && t.start < nameToken.start);
  const hasPtr = toks.some(
    (t) =>
      t.kind === "punct" &&
      (t.ch === "*" || t.ch === "&" || t.ch === "&&") &&
      t.start < nameToken.start,
  );
  const hasTemplate = toks.some(
    (t) => t.kind === "punct" && t.ch === ">" && t.start < nameToken.start,
  );
  if (prior < 1 && !hasSpec && !hasPtr && !hasTemplate) return null;
  if (prior < 1 && hasSpec && nameCandidates.length === 1 && !hasPtr) {
    // `const int32` unnamed — the only non-spec ident is the type.
    const specs = depth0Idents.filter((t) => TYPE_SPEC.has(t.name));
    if (specs.length > 0 && specs.every((s) => s.name === "const" || s.name === "volatile")) {
      return null;
    }
  }
  return { nameToken, typeEnd: nameToken.start };
}
