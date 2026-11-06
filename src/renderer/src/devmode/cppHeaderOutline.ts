/**
 * C++ header Outline: class/struct members under public/private/protected.
 * Implementation files (.cpp) are not scanned — only declarations in headers.
 */

import type { DocumentSymbol } from "./documentSymbols.js";

export type CppAccess = "public" | "private" | "protected";

const MAX_SYMBOLS = 400;
const MAX_SIGNATURE_LINES = 16;

const ACCESS_RE =
  /^\s*(public|private|protected)\s*(?:slots)?\s*:/;

const TYPE_HEAD_RE =
  /\b(class|struct|enum)\s+(?:class\s+|struct\s+)?(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)\b/;

const UE_SPEC_RE =
  /^(?:UPROPERTY|UFUNCTION|UCLASS|USTRUCT|UENUM|UINTERFACE|UMETA|UPARAM|UDELEGATE)\s*\(/;

const BARE_MACRO_RE =
  /^(?:GENERATED_BODY|GENERATED_UCLASS_BODY|GENERATED_USTRUCT_BODY|UE_LOG|checkf?|ensure(?:Always)?|Q_OBJECT|DECLARE_[A-Za-z0-9_]+|IMPLEMENT_[A-Za-z0-9_]+)\s*(?:$|\()/;

const SKIP_MEMBER_START =
  /^(?:friend|using|typedef|typename|namespace|static_assert|static_cast|dynamic_cast|reinterpret_cast|const_cast)\b/;

const HEADER_EXT = /\.(h|hh|hpp|hxx|inl)$/i;
const SOURCE_EXT = /\.(c|cc|cpp|cxx)$/i;

export function isCppHeaderPath(path: string): boolean {
  return HEADER_EXT.test(path.replace(/\\/g, "/"));
}

export function isCppSourcePath(path: string): boolean {
  return SOURCE_EXT.test(path.replace(/\\/g, "/"));
}

/**
 * Header candidates for an implementation file (source → header).
 * Same-dir ext swap plus Unreal's module layout conventions:
 *   Private/A/B/Foo.cpp → Public/A/B/Foo.h, Classes/A/B/Foo.h, A/B/Foo.h;
 *   a module-root cpp also probes Public/ and Classes/.
 */
export function siblingHeaderCandidates(sourcePath: string): string[] {
  const norm = sourcePath.replace(/\\/g, "/");
  const m = /^(.*)\/([^/]+)\.(?:cpp|cc|cxx|c)$/i.exec(norm);
  if (!m) return [];
  const dir = m[1]!;
  const base = m[2]!;
  const exts = [".h", ".hpp", ".hxx", ".hh"];
  const folders = new Set<string>([dir]);
  if (/\/Private\b/i.test(dir)) {
    folders.add(dir.replace(/\/Private\b/i, "/Public"));
    folders.add(dir.replace(/\/Private\b/i, "/Classes"));
    folders.add(dir.replace(/\/Private$/i, ""));
  } else {
    // Module-root source: its header usually sits in Public/ or Classes/.
    folders.add(`${dir}/Public`);
    folders.add(`${dir}/Classes`);
  }
  const out: string[] = [];
  for (const folder of folders) {
    if (!folder) continue;
    for (const ext of exts) out.push(`${folder}/${base}${ext}`);
  }
  return out;
}

/**
 * Reverse of siblingHeaderCandidates: implementation candidates for a
 * header — same-dir ext swap plus Unreal's module layout conventions:
 *   Public/A/B/Foo.h  → Private/A/B/Foo.cpp (+ module root);
 *   Classes/A/B/Foo.h → Private/A/B/Foo.cpp (+ module root)  [engine];
 *   a module-root header also probes Private/.
 * `.cpp` first (Unreal's norm), then .cc / .cxx / .c.
 */
export function siblingSourceCandidates(headerPath: string): string[] {
  const norm = headerPath.replace(/\\/g, "/");
  const m = /^(.*)\/([^/]+)\.(?:h|hh|hpp|hxx|inl)$/i.exec(norm);
  if (!m) return [];
  const dir = m[1]!;
  const base = m[2]!;
  const exts = [".cpp", ".cc", ".cxx", ".c"];
  const folders = new Set<string>([dir]);
  if (/\/Public\b/i.test(dir)) {
    folders.add(dir.replace(/\/Public\b/i, "/Private"));
    folders.add(dir.replace(/\/Public$/i, ""));
  } else if (/\/Classes\b/i.test(dir)) {
    folders.add(dir.replace(/\/Classes\b/i, "/Private"));
    folders.add(dir.replace(/\/Classes$/i, ""));
  } else {
    // Module-root header: the implementation usually lives in Private/.
    folders.add(`${dir}/Private`);
  }
  const out: string[] = [];
  for (const folder of folders) {
    if (!folder) continue;
    for (const ext of exts) out.push(`${folder}/${base}${ext}`);
  }
  return out;
}

function skipLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return true;
  if (trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  if (trimmed.startsWith("#")) return true;
  return false;
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
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
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
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  return depth;
}

function collectSpanFrom(
  startText: string,
  lines: readonly string[],
  start: number,
): {
  text: string;
  end: number;
} {
  let buf = startText;
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
  return { text: buf, end: j };
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripLeadingModifiers(s: string): string {
  let out = collapseWs(s);
  const leading =
    /^(?:virtual|static|explicit|constexpr|inline|forceinline|FORCEINLINE|friend|typename|mutable)\s+/i;
  for (let n = 0; n < 8; n++) {
    const next = out.replace(leading, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function nameStartIndex(span: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^\\w$])(${escaped})(?:\\b|(?=$))`);
  const m = re.exec(span);
  if (!m || m.index === undefined || m[1] === undefined) return -1;
  return m.index + m[0].length - m[1].length;
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
      if (ch === "\\" && quote !== "'") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
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

function stripTemplateHead(s: string): string {
  if (!/^\s*template\s*</.test(s)) return s;
  const lt = s.indexOf("<");
  if (lt < 0) return s;
  let depth = 0;
  for (let i = lt; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "<") depth += 1;
    else if (ch === ">") {
      depth -= 1;
      if (depth === 0) return s.slice(i + 1).trim();
    }
  }
  return s;
}

function stripUeSpecifier(s: string): string {
  let out = s.trim();
  for (let n = 0; n < 3; n++) {
    if (!UE_SPEC_RE.test(out)) break;
    const open = out.indexOf("(");
    const sliced = sliceParamList(out, open);
    if (!sliced) break;
    out = out.slice(sliced.closeIndex + 1).trim();
  }
  return out;
}

function stripDeclPrefix(s: string): string {
  return stripUeSpecifier(stripTemplateHead(s));
}

function isBareMacro(s: string): boolean {
  if (BARE_MACRO_RE.test(s)) {
    const open = s.indexOf("(");
    if (open < 0) return true;
    const sliced = sliceParamList(s, open);
    if (!sliced) return true;
    return !s.slice(sliced.closeIndex + 1).trim();
  }
  if (UE_SPEC_RE.test(s)) return !stripUeSpecifier(s);
  return false;
}

function memberSignature(
  span: string,
  name: string,
): { params?: string; returnType?: string } {
  const start = nameStartIndex(span, name);
  const parenFrom = start >= 0 ? span.indexOf("(", start) : span.indexOf("(");
  const sliced = sliceParamList(span, parenFrom);
  const params = sliced?.params ?? "";
  let before = start >= 0 ? span.slice(0, start).trim() : "";
  const qual = before.lastIndexOf("::");
  if (qual >= 0) {
    before = before.slice(0, qual).replace(/~?[A-Za-z_]\w*\s*$/, "");
  }
  const returnType = stripLeadingModifiers(before);
  const out: { params?: string; returnType?: string } = { params };
  if (returnType) out.returnType = returnType;
  return out;
}

function typeKind(keyword: string): DocumentSymbol["kind"] {
  if (keyword === "struct") return "struct";
  if (keyword === "enum") return "enum";
  return "class";
}

function defaultAccess(keyword: string): CppAccess {
  return keyword === "struct" ? "public" : "private";
}

function isForwardType(line: string): boolean {
  return /;\s*$/.test(line.trim()) && !line.includes("{") && !line.includes("(");
}

function parseTypeHead(
  line: string,
): { keyword: string; name: string } | null {
  const trimmed = line.trim();
  if (isForwardType(trimmed)) return null;
  const m = TYPE_HEAD_RE.exec(line);
  if (!m) return null;
  return { keyword: m[1]!, name: m[2]! };
}

function operatorName(span: string): string | null {
  const m =
    /operator\s*(?:\[\s*\]|\(\s*\)|->\*|->|[^\s(]+)\s*\(/.exec(span);
  if (!m) return null;
  const token = /operator\s*([^\s(]+|\(\s*\)|\[\s*\])/.exec(m[0]);
  return token ? `operator${collapseWs(token[1]!)}` : "operator";
}

function functionName(span: string): string | null {
  const op = operatorName(span);
  if (op) return op;
  const paren = span.indexOf("(");
  if (paren <= 0) return null;
  const before = span.slice(0, paren);
  const m = /(~?[A-Za-z_]\w*)\s*$/.exec(before);
  return m?.[1] ?? null;
}

function parseField(span: string): { name: string; returnType: string } | null {
  let body = collapseWs(span).replace(/;\s*$/, "");
  if (!body || body.includes("(")) return null;
  body = body.split("=")[0]!.split("{")[0]!.replace(/:\s*\d+\s*$/, "").trim();
  body = body.replace(/\[[^\]]*\]\s*$/, "").trim();
  const m = /([A-Za-z_]\w*)\s*$/.exec(body);
  if (!m || m.index === undefined) return null;
  const name = m[1]!;
  if (/^(?:public|private|protected|const|static|mutable|volatile|class|struct|enum|unsigned|signed)$/.test(name)) {
    return null;
  }
  let returnType = collapseWs(body.slice(0, m.index));
  for (let n = 0; n < 6; n++) {
    const next = returnType.replace(
      /^(?:mutable|static|constexpr|const|volatile)\s+/,
      "",
    );
    if (next === returnType) break;
    returnType = next;
  }
  return { name, returnType };
}

type ClassFrame = {
  braceDepth: number;
  access: CppAccess;
};

function ensureAccessHeader(
  symbols: DocumentSymbol[],
  lastAccessAtDepth: Map<number, CppAccess>,
  depth: number,
  access: CppAccess,
  line: number,
): void {
  if (lastAccessAtDepth.get(depth) === access) return;
  lastAccessAtDepth.set(depth, access);
  symbols.push({
    name: access,
    kind: "access",
    line,
    depth,
    access,
  });
}

function isCtorInitializerRhs(span: string): boolean {
  // `FVector X = FVector(0.f);` / `void F(FVector V = FVector(1));` /
  // `T X = {FVector(0.f), 0};` — the identifier before the first paren sits
  // in an initializer expression, not a member declaration.
  const paren = span.indexOf("(");
  if (paren <= 0) return false;
  const m = /(~?[A-Za-z_]\w*)\s*$/.exec(span.slice(0, paren));
  if (!m || m.index === undefined || m.index <= 0) return false;
  let k = m.index - 1;
  while (k >= 0 && /\s/.test(span[k]!)) k -= 1;
  if (k < 0) return false;
  if (span[k] === "=") return true;
  if (span[k] === "{" || span[k] === ",") {
    return span.slice(0, k).includes("=");
  }
  return false;
}

function pushMember(
  symbols: DocumentSymbol[],
  span: string,
  line: number,
  depth: number,
  access: CppAccess,
  lastAccessAtDepth: Map<number, CppAccess>,
): void {
  let trimmed = stripDeclPrefix(collapseWs(span));
  if (!trimmed || trimmed === ";" || trimmed === "}" || trimmed === "};") return;
  if (isBareMacro(trimmed)) return;
  if (SKIP_MEMBER_START.test(trimmed)) return;
  if (ACCESS_RE.test(trimmed)) return;

  if (trimmed.includes("(")) {
    const ctorInitRhs = isCtorInitializerRhs(trimmed);
    if (!ctorInitRhs) {
      const name = functionName(trimmed);
      if (!name) return;
      if (isBareMacro(name + "(")) return;
      const extra = memberSignature(trimmed, name);
      ensureAccessHeader(symbols, lastAccessAtDepth, depth, access, line);
      const symbol: DocumentSymbol = {
        name,
        kind: "function",
        line,
        depth,
        access,
      };
      if (extra.params !== undefined) symbol.params = extra.params;
      if (extra.returnType) symbol.returnType = extra.returnType;
      symbols.push(symbol);
      return;
    }
    // Initializer RHS: strip the constructor call so parseField can name
    // the declared variable (parameter-default lines still drop out).
    trimmed = trimmed.slice(0, trimmed.indexOf("=")).replace(/\s*$/, ";");
  }

  if (!/;\s*$/.test(trimmed) && !trimmed.endsWith(";")) {
    if (!trimmed.includes(";")) return;
  }
  const field = parseField(trimmed);
  if (!field) return;
  ensureAccessHeader(symbols, lastAccessAtDepth, depth, access, line);
  const symbol: DocumentSymbol = {
    name: field.name,
    kind: "variable",
    line,
    depth,
    access,
  };
  if (field.returnType) symbol.returnType = field.returnType;
  symbols.push(symbol);
}

export function scanCppHeader(
  text: string,
  maxSymbols: number = MAX_SYMBOLS,
): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const lines = text.split(/\r?\n/);
  const stack: ClassFrame[] = [];
  let brace = 0;
  const lastAccessAtDepth = new Map<number, CppAccess>();

  for (let i = 0; i < lines.length; i++) {
    if (Number.isFinite(maxSymbols) && symbols.length >= maxSymbols) break;
    const raw = lines[i]!;
    if (skipLine(raw)) continue;
    const trimmed = raw.trim();
    const frame = stack[stack.length - 1];
    const atClassBody = Boolean(frame) && brace === frame!.braceDepth;

    let stmt = trimmed;
    const accessMatch = ACCESS_RE.exec(trimmed);
    if (accessMatch && atClassBody) {
      const access = accessMatch[1] as CppAccess;
      frame!.access = access;
      if (lastAccessAtDepth.get(stack.length) !== access) {
        lastAccessAtDepth.set(stack.length, access);
        symbols.push({
          name: access,
          kind: "access",
          line: i + 1,
          depth: stack.length,
          access,
        });
      }
      stmt = trimmed.slice(accessMatch[0].length).trim();
      if (!stmt) {
        brace += braceDelta(raw);
        continue;
      }
    }

    const head = parseTypeHead(stmt);
    if (head && (!frame || atClassBody || brace === 0)) {
      const depth = stack.length;
      symbols.push({
        name: head.name,
        kind: typeKind(head.keyword),
        line: i + 1,
        depth,
      });
      const delta = braceDelta(raw);
      if (delta > 0) {
        brace += delta;
        stack.push({
          braceDepth: brace,
          access: defaultAccess(head.keyword),
        });
      } else if (stmt.includes("{")) {
        // One-line body (`class FTag {};`) — no frame, or every later
        // file-scope line would be read as a member of this type.
        brace += delta;
      } else {
        // `class Foo : public Bar` — opening brace is on a later line.
        let j = i + 1;
        while (j < lines.length && j - i < 8) {
          const look = lines[j]!;
          if (skipLine(look) && !look.includes("{")) {
            j += 1;
            continue;
          }
          brace += braceDelta(look);
          if (look.includes("{")) {
            stack.push({
              braceDepth: brace,
              access: defaultAccess(head.keyword),
            });
            i = j;
            break;
          }
          if (look.includes(";")) break;
          j += 1;
        }
      }
      while (stack.length > 0 && brace < stack[stack.length - 1]!.braceDepth) {
        lastAccessAtDepth.delete(stack.length);
        stack.pop();
      }
      continue;
    }

    if (atClassBody) {
      const collected = collectSpanFrom(stmt, lines, i);
      pushMember(
        symbols,
        collected.text,
        i + 1,
        stack.length,
        frame!.access,
        lastAccessAtDepth,
      );
      for (let k = i; k <= collected.end; k++) {
        brace += braceDelta(lines[k]!);
      }
      while (stack.length > 0 && brace < stack[stack.length - 1]!.braceDepth) {
        lastAccessAtDepth.delete(stack.length);
        stack.pop();
      }
      i = collected.end;
      continue;
    }

    brace += braceDelta(raw);
    while (stack.length > 0 && brace < stack[stack.length - 1]!.braceDepth) {
      lastAccessAtDepth.delete(stack.length);
      stack.pop();
    }
  }
  return symbols;
}
