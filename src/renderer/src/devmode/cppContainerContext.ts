
import { scanCppImplLine } from "./cppSymbolIndex.js";

export const MAX_CONTAINER_SCAN_LINES = 4000;
const MAX_HEAD_JOIN_LINES = 6;
const MAX_HEAD_CHARS = 1200;
const MAX_LINE_CHARS = 400;
const MAX_OUTWARD_HOPS = 24;

const TYPE_HEAD_RE =
  /\b(class|struct|enum)\s+(?:class\s+|struct\s+)?(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)\b/;

const ACCESS_RE = /^\s*(?:public|private|protected)\s*(?:slots)?\s*:/;

export type CppContainerSource =
  | "impl-signature"
  | "type-body";

export type CppContainerContext = {
  container: string | null;
  containerChain?: string;
  line?: number;
  source?: CppContainerSource;
};

const NO_CONTAINER: CppContainerContext = { container: null };

export function stripCommentsForScan(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";
  if (trimmed.startsWith("#")) return "";
  let out = line.replace(/\/\*[^*]*\*\//g, " ");
  const lineComment = out.indexOf("//");
  if (lineComment >= 0) out = out.slice(0, lineComment);
  const blockStart = out.indexOf("/*");
  if (blockStart >= 0) out = out.slice(0, blockStart);
  return out;
}

export function braceDeltaOf(code: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
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
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

function netOpenParens(code: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
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
    else if (ch === ")") depth -= 1;
  }
  return depth;
}

function headBeforeBrace(code: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
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
    if (ch === "{") {
      if (depth === 0) return code.slice(0, i);
      depth -= 1;
    } else if (ch === "}") depth += 1;
  }
  return code;
}

function isForwardDecl(head: string): boolean {
  return /;\s*$/.test(head.trim());
}

export function stripTemplateArgs(text: string): string {
  let out = text;
  for (let n = 0; n < 6; n++) {
    const next = out.replace(/([A-Za-z_]\w*)\s*<[^<>]*>/g, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}

export function classifyBlockHead(head: string): CppContainerContext | null {
  const text = head.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_HEAD_CHARS) return null;
  const candidates =
    text.includes("<") && text.includes(">")
      ? [text, stripTemplateArgs(text)]
      : [text];

  for (const candidate of candidates) {
    const qualified = scanCppImplLine(candidate);
    if (qualified?.container) {
      return {
        container: qualified.container,
        containerChain: qualified.containerChain,
        source: "impl-signature",
      };
    }
  }

  if (isForwardDecl(text)) return null;
  for (const candidate of candidates) {
    const type = TYPE_HEAD_RE.exec(candidate);
    if (type?.[2]) {
      return { container: type[2], source: "type-body" };
    }
  }
  return null;
}

function collectBlockHead(
  lines: readonly string[],
  openerIndex: number,
): { head: string; headStartIndex: number } {
  let head = headBeforeBrace(stripCommentsForScan(lines[openerIndex]!)).trim();
  let start = openerIndex;
  if (classifyBlockHead(head)) return { head, headStartIndex: start };

  for (let n = 0; n < MAX_HEAD_JOIN_LINES && start > 0; n++) {
    const candidate = stripCommentsForScan(lines[start - 1]!);
    const trimmed = candidate.trim();
    if (
      !trimmed ||
      ACCESS_RE.test(trimmed) ||
      ((/[;{}]$/.test(trimmed) || trimmed.endsWith("};")) &&
        netOpenParens(head) >= 0)
    ) {
      break;
    }
    start -= 1;
    head = head ? `${trimmed} ${head}` : trimmed;
    if (head.length > MAX_HEAD_CHARS) break;
    if (classifyBlockHead(head)) break;
  }
  return { head, headStartIndex: start };
}

export function resolveEnclosingContainer(
  text: string,
  cursorLine: number,
  options?: { maxLinesUp?: number },
): CppContainerContext {
  if (!text || cursorLine < 1) return NO_CONTAINER;
  const lines = text.split(/\r?\n/);
  if (cursorLine > lines.length) return NO_CONTAINER;
  const budget = Math.max(1, options?.maxLinesUp ?? MAX_CONTAINER_SCAN_LINES);

  const cursorIndex = cursorLine - 1;
  const ownLine = lines[cursorIndex] ?? "";
  if (ownLine.length <= MAX_LINE_CHARS) {
    const own = scanCppImplLine(stripCommentsForScan(ownLine));
    if (own?.container) {
      return {
        container: own.container,
        containerChain: own.containerChain,
        line: cursorLine,
        source: "impl-signature",
      };
    }
  }

  let index = cursorIndex - 1;
  const floor = Math.max(0, cursorIndex - budget);
  for (let hop = 0; hop < MAX_OUTWARD_HOPS; hop++) {
    let balance = 0;
    let openerIndex = -1;
    for (; index >= floor; index--) {
      const code = stripCommentsForScan(lines[index]!);
      if (!code) continue;
      balance += braceDeltaOf(code);
      if (balance > 0) {
        openerIndex = index;
        break;
      }
    }
    if (openerIndex < 0) return NO_CONTAINER;

    const { head, headStartIndex } = collectBlockHead(lines, openerIndex);
    const hit = classifyBlockHead(head);
    if (hit) return { ...hit, line: headStartIndex + 1 };
    index = headStartIndex - 1;
  }
  return NO_CONTAINER;
}
