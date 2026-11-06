/**
 * L2 container context for C++ go-to-definition: the class that *encloses*
 * the caret, recovered by scanning the buffer — no LSP, no AST.
 *
 * `qualifiedContainerBefore` (cppLanguageFeatures.ts) only fires when the
 * source literally spells `Class::Name` at the call site. That leaves the
 * common cases blind:
 *
 *   - `.h` member declarations   `virtual void BeginPlay() override;`
 *   - `.cpp` bare calls in a body `BeginPlay();`
 *   - receiver calls             `Char->BeginPlay();`
 *
 * In all three the enclosing `Class::Method` (or `class Foo {`) block head
 * names a class that is a strong ranking hint. This module walks up from
 * the caret line, balancing braces, and reports the innermost enclosing
 * type. The result feeds `CppDefinitionLookup.enclosingContainer`, which
 * *boosts* same-class candidates without penalising anything — a wrong
 * guess can never demote the answer the ranker would have picked anyway.
 *
 * Pure and browser-free; node --test covers it (cppContainerContext.test.ts).
 *
 * Known limits (deliberate): multi-line `/* … *\/` comments holding unbalanced
 * braces, `#if 0` blocks, and raw string literals can skew the brace walk.
 * All of them degrade to `container: null`, i.e. today's behaviour.
 */

import { scanCppImplLine } from "./cppSymbolIndex.js";

/** How far above the caret the walk may look before giving up. */
export const MAX_CONTAINER_SCAN_LINES = 4000;
/** Lines joined upwards to rebuild a block head whose `{` sits alone. */
const MAX_HEAD_JOIN_LINES = 6;
/** Block heads longer than this are treated as noise. */
const MAX_HEAD_CHARS = 1200;
/** Lines this long are macro tables / generated data, not block heads. */
const MAX_LINE_CHARS = 400;
/** Outward hops (`{` blocks) inspected before giving up. */
const MAX_OUTWARD_HOPS = 24;

const TYPE_HEAD_RE =
  /\b(class|struct|enum)\s+(?:class\s+|struct\s+)?(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)\b/;

/** `public:` / `private slots:` — a head join must not cross these. */
const ACCESS_RE = /^\s*(?:public|private|protected)\s*(?:slots)?\s*:/;

export type CppContainerSource =
  /** Derived from an enclosing `Class::Method(` definition. */
  | "impl-signature"
  /** Derived from an enclosing `class` / `struct` / `enum` body. */
  | "type-body";

export type CppContainerContext = {
  /** Innermost enclosing class/struct/enum name, or null when unknown. */
  container: string | null;
  /** Full `A::B::` chain, when the hit came from a qualified definition. */
  containerChain?: string;
  /** 1-based line of the block head the container was read from. */
  line?: number;
  /** Which rule produced the container (diagnostics / tests). */
  source?: CppContainerSource;
};

const NO_CONTAINER: CppContainerContext = { container: null };

/**
 * Drop `//` tails and single-line `/* … *\/` spans so brace counting and head
 * classification ignore commented braces. Leading `*` continuation lines and
 * preprocessor directives collapse to an empty string.
 */
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

/**
 * `{` minus `}` on one line, ignoring braces inside string/char literals.
 * The input is expected to be comment-stripped already.
 */
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

/** Text of an opener line up to (not including) its unmatched `{`. */
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

/**
 * Collapse `Name<Args>` to `Name` so template heads reach the qualified-name
 * scanner: `template <typename T> void TRing<T>::Push(…)` becomes
 * `template void TRing::Push(…)`. Innermost args go first, so nested
 * `TMap<FName, TArray<int32>>` also flattens. Only used as a second attempt
 * — plain heads never see the rewrite.
 */
export function stripTemplateArgs(text: string): string {
  let out = text;
  for (let n = 0; n < 6; n++) {
    const next = out.replace(/([A-Za-z_]\w*)\s*<[^<>]*>/g, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Read a container out of one block head. `null` means "not a type or method
 * head" (control flow, lambda, plain scope) — the caller keeps walking out.
 */
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

/**
 * Rebuild the block head that opens at `openerIndex`, joining lines upwards
 * when the `{` sits on its own line (Allman / UE style) or the signature
 * wraps. Returns the head text plus the topmost line it consumed.
 */
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
    // A statement boundary above means the block has no head of its own
    // (plain scope block) — except while a wrapped signature is still open.
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

/**
 * Innermost class/struct enclosing `cursorLine` (1-based).
 *
 * Walks upwards balancing braces: the first line whose running delta turns
 * positive owns an unmatched `{`, i.e. opens the block holding the caret.
 * Non-class heads (`if`, lambdas, plain scopes, namespaces) hop outwards to
 * the next enclosing block, so a method body inside a class still resolves
 * to the class.
 *
 * The caret's own line is inspected only for a `Class::Method(` head, which
 * makes F12 work anywhere on an implementation signature (e.g. on a
 * parameter type). Type heads on the caret line are ignored on purpose:
 * `class ANFCharacter : public AActor` with the caret on `AActor` must not
 * claim ANFCharacter as the container.
 */
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
