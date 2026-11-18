
export type UeAccess = "public" | "private" | "protected";

export type UeReflectionMacro = "UPROPERTY" | "UFUNCTION";

export type UeReflectionMember = {
  macro: UeReflectionMacro;
  specifiers: string[];
  values: Record<string, string>;
  line: number;
  endLine: number;
  access: UeAccess;
  name: string;
  params?: string;
  type?: string;
  staticArray?: boolean;
  bitfield?: boolean;
  decl: string;
};

export type UeClassScan = {
  className: string;
  kind: "class" | "struct";
  bases: string[];
  headLine: number;
  bodyOpenLine: number;
  bodyCloseLine: number;
  bodyStartOffset: number;
  bodyEndOffset: number;
  members: UeReflectionMember[];
};

export type UeImplBody = {
  name: string;
  params: string;
  startLine: number;
  openLine: number;
  closeLine: number;
};

const MACRO_RE = /\b(UPROPERTY|UFUNCTION)\s*\(/g;
const CLASS_HEAD_RE =
  /\b(class|struct)\s+(?:[A-Za-z_][A-Za-z0-9_]*_API\s+)?([A-Za-z_]\w*)\b/g;
const ACCESS_RE = /^(public|private|protected)\s*(?:slots)?\s*:/;
const SKIP_STATEMENT_RE =
  /^(?:GENERATED_BODY|GENERATED_UCLASS_BODY|GENERATED_USTRUCT_BODY|UE_LOG|checkf?|ensure(?:Always)?|DECLARE_[A-Za-z0-9_]+|IMPLEMENT_[A-Za-z0-9_]+|friend|using|typedef|static_assert|namespace)\b/;

export function maskCpp(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < n) {
        out[i] = " ";
        if (i + 1 < n) out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i] = quote;
      i += 1;
      while (i < n) {
        const c = text[i]!;
        if (c === "\\") {
          out[i] = " ";
          if (i + 1 < n) out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === quote) {
          out[i] = quote;
          i += 1;
          break;
        }
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

export function positionAt(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

export function offsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      seen += 1;
      if (seen === line) return i + 1;
    }
  }
  return text.length;
}

export function endOfLine(text: string, line: number): number {
  const start = offsetOfLine(text, line);
  const nl = text.indexOf("\n", start);
  return nl === -1 ? text.length : nl + 1;
}

export function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type ClassCandidate = {
  match: RegExpExecArray;
  open: number;
  close: number;
  headLine: number;
  bodyOpenLine: number;
  bodyCloseLine: number;
};

function classCandidates(masked: string): ClassCandidate[] {
  const out: ClassCandidate[] = [];
  CLASS_HEAD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_HEAD_RE.exec(masked)) !== null) {
    let j = m.index + m[0].length;
    while (j < masked.length && /\s/.test(masked[j]!)) j += 1;
    if (masked[j] === ";") continue;
    let open = -1;
    for (let k = j; k < masked.length; k++) {
      const ch = masked[k];
      if (ch === "{") {
        open = k;
        break;
      }
      if (ch === ";") break;
    }
    if (open < 0) continue;
    const close = matchBrace(masked, open);
    if (close < 0) continue;
    out.push({
      match: m,
      open,
      close,
      headLine: positionAt(masked, m.index).line,
      bodyOpenLine: positionAt(masked, open).line,
      bodyCloseLine: positionAt(masked, close).line,
    });
  }
  return out;
}

function baseClassesFrom(headText: string, className: string): string[] {
  const colon = headText.indexOf(":");
  if (colon < 0) return [];
  const tail = headText.slice(colon + 1);
  return tail
    .split(",")
    .map((part) =>
      part
        .replace(/\b(public|private|protected|virtual)\b/g, " ")
        .trim()
        .split(/[\s<]/)
        .filter(Boolean)
        .pop() ?? "",
    )
    .filter((name) => Boolean(name) && name !== className);
}

export function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}

export function splitSpecifiers(raw: string): {
  specifiers: string[];
  values: Record<string, string>;
} {
  const specifiers = splitTopLevel(raw).map((token) =>
    token.replace(/\s+/g, " ").trim(),
  );
  const values: Record<string, string> = {};
  for (const token of specifiers) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).trim().toLowerCase();
    const value = token.slice(eq + 1).trim();
    if (key && !(key in values)) values[key] = value;
  }
  return { specifiers, values };
}

export function hasSpecifier(member: UeReflectionMember, name: string): boolean {
  const lower = name.toLowerCase();
  return member.specifiers.some((token) => {
    const eq = token.indexOf("=");
    const key = (eq < 0 ? token : token.slice(0, eq)).trim().toLowerCase();
    return key === lower;
  });
}

export function stripDefaultArgs(params: string): string {
  return splitTopLevel(params)
    .map((param) => {
      const eq = param.indexOf("=");
      return (eq < 0 ? param : param.slice(0, eq)).trim();
    })
    .filter(Boolean)
    .join(", ");
}

const MODIFIER_RE =
  /^(?:virtual|static|inline|explicit|constexpr|FORCEINLINE|FORCENOINLINE|friend|typename|mutable|class|struct|enum|const|volatile)\s+/;

function stripModifiers(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (let n = 0; n < 8; n++) {
    const next = out.replace(MODIFIER_RE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

const SCALAR_TYPE_RE =
  /^(?:bool|uint8|int8|uint16|int16|uint32|int32|uint64|int64|float|double|FName|TEnumAsByte<[^>]+>|E[A-Z]\w*)$/;

export function isScalarType(type: string): boolean {
  return SCALAR_TYPE_RE.test(stripModifiers(type));
}

type ParsedStatement = {
  macro: UeReflectionMacro;
  specifiers: string[];
  values: Record<string, string>;
  decl: string;
  offset: number;
};

function leadingMacro(
  masked: string,
  start: number,
  end: number,
): ParsedStatement | null {
  let k = start;
  while (k < end && /\s/.test(masked[k]!)) k += 1;
  MACRO_RE.lastIndex = k;
  const m = MACRO_RE.exec(masked);
  if (!m || m.index !== k) return null;
  const open = k + m[0].length - 1;
  const close = matchParen(masked, open);
  if (close < 0 || close >= end) return null;
  const raw = masked.slice(open + 1, close);
  const { specifiers, values } = splitSpecifiers(raw);
  return {
    macro: m[1] as UeReflectionMacro,
    specifiers,
    values,
    decl: "",
    offset: k,
  };
}

function parseFunctionDecl(
  decl: string,
): { name: string; params: string; type?: string } | null {
  const paren = decl.indexOf("(");
  if (paren <= 0) return null;
  const before = decl.slice(0, paren);
  const m = /(~?[A-Za-z_]\w*)\s*$/.exec(before);
  if (!m) return null;
  const name = m[1]!;
  const maskedParen = matchParen(decl, paren);
  const params = (
    maskedParen > paren ? decl.slice(paren + 1, maskedParen) : ""
  ).replace(/\s+/g, " ").trim();
  const type = stripModifiers(before.slice(0, m.index));
  const out: { name: string; params: string; type?: string } = { name, params };
  if (type) out.type = type;
  return out;
}

function parsePropertyDecl(decl: string): {
  name: string;
  type: string;
  staticArray?: boolean;
  bitfield?: boolean;
} | null {
  let body = decl.replace(/\s+/g, " ").trim().replace(/;$/, "");
  if (!body || body.includes("(")) {
    const eq = body.indexOf("=");
    if (eq < 0) return null;
    body = body.slice(0, eq).trim();
  }
  const eq = body.indexOf("=");
  if (eq >= 0) body = body.slice(0, eq).trim();
  let bitfield = false;
  const bit = /:\s*\d+\s*$/.exec(body);
  if (bit) {
    bitfield = true;
    body = body.slice(0, bit.index).trim();
  }
  let staticArray = false;
  const arr = /\[[^\]]*\]\s*$/.exec(body);
  if (arr) {
    staticArray = true;
    body = body.slice(0, arr.index).trim();
  }
  const m = /([A-Za-z_]\w*)\s*$/.exec(body);
  if (!m || m.index === undefined) return null;
  const name = m[1]!;
  const type = stripModifiers(body.slice(0, m.index));
  if (!type) return null;
  if (
    /^(?:public|private|protected|const|static|mutable|volatile|class|struct|enum|unsigned|signed)$/.test(
      name,
    )
  ) {
    return null;
  }
  const out: {
    name: string;
    type: string;
    staticArray?: boolean;
    bitfield?: boolean;
  } = { name, type };
  if (staticArray) out.staticArray = true;
  if (bitfield) out.bitfield = true;
  return out;
}

function collectMembers(
  headerText: string,
  masked: string,
  candidate: ClassCandidate,
): UeReflectionMember[] {
  const members: UeReflectionMember[] = [];
  let access: UeAccess =
    candidate.match[1] === "struct" ? "public" : "private";
  let i = candidate.open + 1;
  const bodyEnd = candidate.close;

  const lineStartOf = (offset: number): number => {
    let k = offset;
    while (k > 0 && masked[k - 1] !== "\n") k -= 1;
    return k;
  };
  const skipLine = (offset: number): number => {
    const nl = masked.indexOf("\n", offset);
    return nl === -1 ? bodyEnd : nl + 1;
  };

  while (i < bodyEnd) {
    const ch = masked[i]!;
    if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    const ls = lineStartOf(i);
    const lineEnd = skipLine(i);
    const lineText = masked.slice(ls, lineEnd);
    const trimmedLine = lineText.trim();
    if (/^\s*#/.test(lineText)) {
      i = lineEnd;
      continue;
    }
    const accessMatch = ACCESS_RE.exec(trimmedLine);
    if (accessMatch) {
      access = accessMatch[1] as UeAccess;
      i = lineEnd;
      continue;
    }
    if (SKIP_STATEMENT_RE.test(trimmedLine) && !/[;{}]/.test(trimmedLine)) {
      i = lineEnd;
      continue;
    }
    const stmtStart = i;
    let k = i;
    let brace = 0;
    let paren = 0;
    let sawBrace = false;
    let stmtEnd = -1;
    while (k < bodyEnd) {
      const c = masked[k]!;
      if (c === "(") paren += 1;
      else if (c === ")") paren = Math.max(0, paren - 1);
      else if (c === "{") {
        brace += 1;
        sawBrace = true;
      } else if (c === "}") {
        brace -= 1;
        if (sawBrace && brace === 0) {
          stmtEnd = k + 1;
          break;
        }
      } else if (c === ";" && brace === 0 && paren === 0) {
        stmtEnd = k + 1;
        break;
      }
      k += 1;
    }
    if (stmtEnd < 0) stmtEnd = bodyEnd;
    const stmtMasked = masked.slice(stmtStart, stmtEnd);
    const head = leadingMacro(masked, stmtStart, stmtEnd);
    if (!head) {
      void stmtMasked;
      i = stmtEnd;
      continue;
    }
    let declStart = head.offset;
    let macroInfo: ParsedStatement | null = head;
    let specifiers = head.specifiers;
    let values = head.values;
    while (macroInfo) {
      const open = macroInfo.offset + macroInfo.macro.length;
      const paren = masked.indexOf("(", open);
      const close = paren < 0 ? -1 : matchParen(masked, paren);
      if (close < 0 || close >= stmtEnd) break;
      declStart = close + 1;
      const next = leadingMacro(masked, declStart, stmtEnd);
      if (!next) break;
      specifiers = [...specifiers, ...next.specifiers];
      values = { ...values, ...next.values };
      macroInfo = next;
    }
    const declRaw = headerText.slice(declStart, stmtEnd).trim();
    const decl = declRaw.replace(/\s+/g, " ").trim();
    const startLine = positionAt(headerText, stmtStart).line;
    const endLine = positionAt(headerText, Math.max(stmtStart, stmtEnd - 1)).line;
    if (head.macro === "UFUNCTION") {
      const fn = parseFunctionDecl(decl);
      if (fn) {
        const member: UeReflectionMember = {
          macro: "UFUNCTION",
          specifiers,
          values,
          line: startLine,
          endLine,
          access,
          name: fn.name,
          decl,
        };
        if (fn.params !== "") member.params = fn.params;
        if (fn.type) member.type = fn.type;
        members.push(member);
      }
    } else {
      const prop = parsePropertyDecl(decl);
      if (prop) {
        const member: UeReflectionMember = {
          macro: "UPROPERTY",
          specifiers,
          values,
          line: startLine,
          endLine,
          access,
          name: prop.name,
          type: prop.type,
          decl,
        };
        if (prop.staticArray) member.staticArray = true;
        if (prop.bitfield) member.bitfield = true;
        members.push(member);
      }
    }
    i = stmtEnd;
  }
  return members;
}

export function scanUnrealClass(
  headerText: string,
  preferLine?: number,
): UeClassScan | null {
  const masked = maskCpp(headerText);
  const candidates = classCandidates(masked);
  if (candidates.length === 0) return null;
  let chosen =
    preferLine === undefined
      ? undefined
      : candidates.find(
          (c) => preferLine > c.bodyOpenLine && preferLine < c.bodyCloseLine,
        );
  if (!chosen) {
    let best: { candidate: ClassCandidate; members: UeReflectionMember[] } | null =
      null;
    for (const candidate of candidates) {
      const members = collectMembers(headerText, masked, candidate);
      if (members.length > 0 && (!best || members.length > best.members.length)) {
        best = { candidate, members };
      }
    }
    const members = best
      ? best.members
      : collectMembers(headerText, masked, candidates[0]!);
    const candidate = best?.candidate ?? candidates[0]!;
    return finish(candidate, members);
  }
  return finish(chosen, collectMembers(headerText, masked, chosen));

  function finish(
    candidate: ClassCandidate,
    members: UeReflectionMember[],
  ): UeClassScan {
    const headStart = offsetOfLine(headerText, candidate.headLine);
    const headText = masked.slice(headStart, candidate.open);
    return {
      className: candidate.match[2]!,
      kind: candidate.match[1] === "struct" ? "struct" : "class",
      bases: baseClassesFrom(headText, candidate.match[2]!),
      headLine: candidate.headLine,
      bodyOpenLine: candidate.bodyOpenLine,
      bodyCloseLine: candidate.bodyCloseLine,
      bodyStartOffset: candidate.open + 1,
      bodyEndOffset: candidate.close,
      members,
    };
  }
}

export function scanImplBodies(
  sourceText: string,
  className: string,
): UeImplBody[] {
  const masked = maskCpp(sourceText);
  const out: UeImplBody[] = [];
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\s*::\\s*(~?[A-Za-z_]\\w*)\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchParen(masked, openParen);
    if (closeParen < 0) continue;
    let k = closeParen + 1;
    while (k < masked.length && masked[k] !== "{" && masked[k] !== ";") k += 1;
    if (k >= masked.length || masked[k] !== "{") continue;
    const close = matchBrace(masked, k);
    if (close < 0) continue;
    out.push({
      name: m[1]!,
      params: sourceText
        .slice(openParen + 1, closeParen)
        .replace(/\s+/g, " ")
        .trim(),
      startLine: positionAt(sourceText, m.index).line,
      openLine: positionAt(sourceText, k).line,
      closeLine: positionAt(sourceText, close).line,
    });
    re.lastIndex = close;
  }
  return out;
}

export function mentionsDeclaration(bodyText: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*\\(`).test(bodyText);
}

export function mentionsIdentifier(bodyText: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(bodyText);
}

export function hasLifetimeRegistration(
  bodyText: string,
  className: string,
  property: string,
): boolean {
  const cls = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prop = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `DOREPLIFETIME\\w*\\s*\\(\\s*(?:${cls}\\s*,\\s*)?${prop}\\b`,
  );
  return re.test(bodyText);
}

export function lineIndent(text: string, line: number): string {
  const start = offsetOfLine(text, line);
  const m = /^[ \t]*/.exec(text.slice(start));
  return m ? m[0] : "";
}

export function detectIndentUnit(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([ \t]+)\S/.exec(line);
    if (m) return m[1]!;
  }
  return "\t";
}

export function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}
