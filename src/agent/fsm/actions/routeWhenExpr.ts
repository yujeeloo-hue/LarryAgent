/**
 * Boolean expressions over turn register flags for RouteTo when[] rows.
 * Syntax: flag names (letters/digits/._-) joined with && and ||; () for grouping.
 * && binds tighter than ||.
 */

import { validateBlackboardKey } from "../blackboardKeys.js";

type Token =
  | { kind: "ident"; value: string }
  | { kind: "and" }
  | { kind: "or" }
  | { kind: "lparen" }
  | { kind: "rparen" };

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function tokenize(expr: string): { ok: true; tokens: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "&" && expr[i + 1] === "&") {
      tokens.push({ kind: "and" });
      i += 2;
      continue;
    }
    if (ch === "|" && expr[i + 1] === "|") {
      tokens.push({ kind: "or" });
      i += 2;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9._-]/.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9._-]/.test(expr[j]!)) j += 1;
      tokens.push({ kind: "ident", value: expr.slice(i, j) });
      i = j;
      continue;
    }
    return { ok: false, error: `unexpected character "${ch}" at position ${i + 1}` };
  }
  return { ok: true, tokens };
}

type ParseResult =
  | { ok: true; flags: string[]; eval: (ctx: Record<string, unknown>) => boolean }
  | { ok: false; error: string };

function parseTokens(tokens: Token[]): ParseResult {
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }

  function consume(): Token {
    const t = tokens[pos];
    if (!t) throw new Error("unexpected end of expression");
    pos += 1;
    return t;
  }

  function parsePrimary(): (ctx: Record<string, unknown>) => boolean {
    const t = peek();
    if (!t) throw new Error("expected flag or '('");
    if (t.kind === "lparen") {
      consume();
      const inner = parseOr();
      if (peek()?.kind !== "rparen") throw new Error("expected ')'");
      consume();
      return inner;
    }
    if (t.kind !== "ident") throw new Error("expected flag name");
    consume();
    const name = t.value;
    return (ctx) => isTruthyFlag(ctx[name]);
  }

  function parseAnd(): (ctx: Record<string, unknown>) => boolean {
    let left = parsePrimary();
    while (peek()?.kind === "and") {
      consume();
      const right = parsePrimary();
      const prev = left;
      left = (ctx) => prev(ctx) && right(ctx);
    }
    return left;
  }

  function parseOr(): (ctx: Record<string, unknown>) => boolean {
    let left = parseAnd();
    while (peek()?.kind === "or") {
      consume();
      const right = parseAnd();
      const prev = left;
      left = (ctx) => prev(ctx) || right(ctx);
    }
    return left;
  }

  try {
    if (tokens.length === 0) {
      return { ok: false, error: "expression is empty" };
    }
    const evalFn = parseOr();
    if (pos < tokens.length) {
      return { ok: false, error: "unexpected tokens after expression" };
    }
    const flags = [
      ...new Set(
        tokens
          .filter((t): t is Token & { kind: "ident" } => t.kind === "ident")
          .map((t) => t.value),
      ),
    ];
    return { ok: true, flags, eval: evalFn };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Parse and compile a when-row expression. */
export function compileRouteWhenExpr(
  expr: string,
): ParseResult {
  const trimmed = expr.trim();
  if (!trimmed) {
    return { ok: false, error: "expression is empty" };
  }
  const tok = tokenize(trimmed);
  if (!tok.ok) return tok;
  return parseTokens(tok.tokens);
}

/** Validate expression syntax and flag key names. Returns halt message or null. */
export function validateRouteWhenExpr(
  expr: string,
  label: string,
): string | null {
  const compiled = compileRouteWhenExpr(expr);
  if (!compiled.ok) {
    return `${label}: invalid when expression: ${compiled.error}`;
  }
  for (const flag of compiled.flags) {
    const keyError = validateBlackboardKey(flag, label);
    if (keyError) return keyError;
  }
  return null;
}

export type RouteWhenExprEval =
  | { kind: "halt"; message: string }
  | { kind: "met"; met: boolean };

export function evaluateRouteWhenExpr(
  expr: string,
  turnContext: Record<string, unknown>,
  label: string,
): RouteWhenExprEval {
  const compiled = compileRouteWhenExpr(expr);
  if (!compiled.ok) {
    return { kind: "halt", message: `${label}: ${compiled.error}` };
  }
  for (const flag of compiled.flags) {
    const keyError = validateBlackboardKey(flag, label);
    if (keyError) {
      return { kind: "halt", message: keyError };
    }
  }
  return { kind: "met", met: compiled.eval(turnContext) };
}

/** Display / migration: legacy key | allOf → expr string. */
export function legacyWhenRowToExpr(row: Record<string, unknown>): string {
  if (typeof row.expr === "string" && row.expr.trim()) {
    return row.expr.trim();
  }
  if (Array.isArray(row.allOf)) {
    const parts = row.allOf
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" && ");
  }
  if (typeof row.key === "string" && row.key.trim()) {
    const raw = row.key.trim();
    if (raw.includes(",")) {
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" && ");
    }
    return raw;
  }
  return "";
}
