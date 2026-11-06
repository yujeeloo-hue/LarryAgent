/**
 * Member completion from clangd's persistent background index — the
 * AST-accurate declaration cache that survives restarts — for the window
 * where a file's own preamble is still building (~45s for a UE .cpp).
 *
 * `workspace/symbol` scope queries (`::ANFCharacter::Att`) are answered
 * from the index without any preamble. The index exposes no inheritance
 * edges, so the class chain is rebuilt by locating each class head through
 * the index and parsing `: public Base` from that header line; member
 * variable types (`Weapon->`) are read the same way from the field's line.
 */

import { parseBaseClasses } from "../cppSymbols/complete.js";
import { memberAccessType } from "../../renderer/src/devmode/cppTextCompletion.js";
import type { CppCompletionHit, CppCompletionRequest, CppSymbolKind } from "../cppSymbols/types.js";

export type IndexSymbol = {
  name: string;
  /** LSP SymbolKind. */
  kind: number;
  containerName?: string;
  path: string;
  /** 1-based. */
  line: number;
};

export type IndexCompletionDeps = {
  /** `workspace/symbol`; [] when the index is not loaded yet. */
  query: (query: string) => Promise<IndexSymbol[]>;
  /** File lines (cached by the caller), null when unreadable. */
  readLines: (path: string) => Promise<string[] | null>;
};

const MAX_CHAIN_DEPTH = 8;
const MAX_HEAD_LINES = 8;
/** clangd caps each scope query at 100; keep room for the base chain. */
const MAX_RESULTS = 400;
/** LSP SymbolKind: Class, Interface, Struct. */
const CLASS_KINDS = new Set([5, 11, 23]);
/**
 * Global-scope kinds offered for a bare identifier: functions, variables /
 * constants, enum members and types. clangd's workspace/symbol never returns
 * macros (verified: UE_LOG / checkf / GENERATED_BODY absent).
 */
const GLOBAL_KINDS = new Set([5, 10, 11, 12, 13, 14, 22, 23]);
/** Unreal type prefixes: `Char` should reach ACharacter, `Vec` FVector. */
const UE_TYPE_PREFIX = /^[AUFEITS][A-Z]/;
const MAX_GLOBAL_RESULTS = 60;
/** LSP SymbolKind: Field, Variable, Constant, EnumMember. */
const FIELD_KINDS = new Set([8, 13, 14, 22]);

function hitKind(kind: number): CppSymbolKind | null {
  switch (kind) {
    case 6:
    case 12:
      return "function";
    case 8:
    case 13:
    case 14:
    case 22:
      return "variable";
    case 5:
      return "class";
    case 23:
      return "struct";
    case 10:
      return "enum";
    case 11:
      return "interface";
    default:
      return null; // constructors, type parameters, namespaces, …
  }
}

/** Prefix match, letting `Char` reach `ACharacter` (UE type prefix). */
function matchesTypedPrefix(name: string, prefix: string): boolean {
  const lower = prefix.toLowerCase();
  const n = name.toLowerCase();
  if (n.startsWith(lower)) return true;
  return UE_TYPE_PREFIX.test(name) && n.slice(1).startsWith(lower);
}

/**
 * Type written immediately before a field name. Earlier tokens on the line
 * (`UPROPERTY(...)`, previous fields) are ignored; UE pointer wrappers unwrap.
 */
function declaredTypeBefore(before: string, field: string): string | null {
  const cleaned = before.replace(/\bUPROPERTY\s*\([^)]*\)/g, " ").trim();
  const tail = /([A-Za-z_][\w:]*(?:\s*<[^;{}()]*(?:<[^;{}()]*>[^;{}()]*)*>)?)\s*[*&]*\s*$/.exec(
    cleaned,
  );
  const type = memberAccessType((tail?.[1] ?? cleaned).trim());
  if (!type || type === field) return null;
  return type;
}

/** Handwritten headers before UHT `.gen.cpp` / `.generated.h` lines. */
function generatedRank(path: string): number {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  if (norm.endsWith(".gen.cpp") || norm.endsWith(".generated.h") || norm.endsWith(".generated.cpp")) {
    return 2;
  }
  if (norm.includes("/intermediate/")) return 2;
  return /\.(h|hpp|hxx|hh)$/.test(norm) ? 0 : 1;
}

/** `NS::ANFCharacter` matches scope `ANFCharacter`. */
function inScope(containerName: string | undefined, scope: string): boolean {
  const c = containerName ?? "";
  return c === scope || c.endsWith(`::${scope}`);
}

export class ClangdIndexCompletion {
  private readonly bases = new Map<string, string[]>();

  constructor(private readonly deps: IndexCompletionDeps) {}

  /** Forget cached inheritance (index reloaded / UHT regenerated). */
  reset(): void {
    this.bases.clear();
  }

  private async directBases(className: string): Promise<string[]> {
    const cached = this.bases.get(className);
    if (cached) return cached;
    const hits = await this.deps.query(`::${className}`);
    const head = hits.find(
      (s) => s.name === className && CLASS_KINDS.has(s.kind) && !s.containerName,
    ) ?? hits.find((s) => s.name === className && CLASS_KINDS.has(s.kind));
    let names: string[] = [];
    if (head) {
      const lines = await this.deps.readLines(head.path);
      if (lines) {
        const text = lines.slice(Math.max(0, head.line - 1), head.line - 1 + MAX_HEAD_LINES).join(" ");
        names = parseBaseClasses(text, className);
      }
    }
    // Cache only a located class head — a half-loaded index must not pin
    // an empty base list.
    if (head) this.bases.set(className, names);
    return names;
  }

  /** `className` + transitive bases (breadth-first) with inheritance depth. */
  async classChain(className: string): Promise<{ name: string; depth: number }[]> {
    const out: { name: string; depth: number }[] = [];
    const seen = new Set<string>();
    let frontier = [className];
    for (let depth = 0; depth <= MAX_CHAIN_DEPTH && frontier.length > 0; depth++) {
      const current = frontier.filter((name) => !seen.has(name));
      current.forEach((name) => {
        seen.add(name);
        out.push({ name, depth });
      });
      const next = await Promise.all(current.map((name) => this.directBases(name)));
      frontier = next.flat();
    }
    return out;
  }

  /** Declared type of member variable `field` along `chain`, from its line. */
  async memberType(chain: readonly { name: string }[], field: string): Promise<string | null> {
    const namePattern = new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const { name } of chain) {
      const hits = (await this.deps.query(`::${name}::${field}`))
        .filter((s) => s.name === field && FIELD_KINDS.has(s.kind) && inScope(s.containerName, name))
        .sort((a, b) => generatedRank(a.path) - generatedRank(b.path));
      for (const decl of hits) {
        const lines = await this.deps.readLines(decl.path);
        if (!lines) continue;
        const declLine = lines[decl.line - 1] ?? "";
        // The declaration line first (`UDataTable* Field;`). A wider slice
        // only if that line has no type (`UDataTable*\n    Field;`).
        const wider = lines
          .slice(Math.max(0, decl.line - 3), Math.min(lines.length, decl.line + 1))
          .join(" ");
        for (const block of wider === declLine ? [declLine] : [declLine, wider]) {
          const mentions = new RegExp(namePattern.source, "g");
          let at = -1;
          for (let m = mentions.exec(block); m; m = mentions.exec(block)) at = m.index;
          if (at < 0) continue;
          const type = declaredTypeBefore(block.slice(0, at), field);
          if (type) return type;
        }
      }
    }
    return null;
  }

  /**
   * Global-scope symbols for a bare identifier — `::Get` is anchored to the
   * global namespace, so it stays a cheap index lookup instead of clangd's
   * all-scopes prefix completion (measured: >8s on a UE .cpp).
   */
  async globals(prefix: string): Promise<CppCompletionHit[]> {
    // Short prefixes match thousands of engine symbols. The curated
    // common-type list covers everyday types before this query starts.
    if (prefix.length < 5) return [];
    const hits = await this.deps.query(`::${prefix}`);
    const out: CppCompletionHit[] = [];
    const seen = new Set<string>();
    for (const s of hits) {
      if (s.containerName || !GLOBAL_KINDS.has(s.kind) || seen.has(s.name)) continue;
      if (!matchesTypedPrefix(s.name, prefix)) continue;
      const kind = hitKind(s.kind);
      if (!kind) continue;
      seen.add(s.name);
      out.push({ name: s.name, kind, path: s.path, line: s.line });
      if (out.length >= MAX_GLOBAL_RESULTS) break;
    }
    return out;
  }

  async complete(request: CppCompletionRequest): Promise<CppCompletionHit[]> {
    const prefix = request.prefix.trim();
    const bare = !request.memberOf && !request.receiver && !(request.chain && request.chain.length > 0);
    const globalsPromise = bare ? this.globals(prefix) : Promise.resolve([]);
    const members = await this.members(request, prefix);
    const globals = await globalsPromise;
    const names = new Set(members.map((hit) => hit.name));
    return [...members, ...globals.filter((hit) => !names.has(hit.name))];
  }

  private async members(request: CppCompletionRequest, prefix: string): Promise<CppCompletionHit[]> {
    let owner = request.memberOf ?? null;
    if (owner === "Super" && request.container) {
      owner = (await this.directBases(request.container))[0] ?? null;
      if (!owner) return [];
    }
    const fields = [...(request.receiver ? [request.receiver] : []), ...(request.chain ?? [])];
    if (fields.length > 0) {
      if (!owner) {
        if (!request.container) return [];
        owner = request.container;
      }
      for (const field of fields) {
        const next = await this.memberType(await this.classChain(owner), field);
        if (!next) return [];
        owner = next;
      }
    } else if (!owner) {
      owner = request.container ?? null;
    }
    if (!owner) return [];

    const chain = await this.classChain(owner);
    const perClass = await Promise.all(
      chain.map(async ({ name, depth }) => {
        const hits = await this.deps.query(`::${name}::${prefix}`);
        return hits
          .filter((s) => inScope(s.containerName, name))
          .map((s) => ({ s, depth, scope: name }));
      }),
    );
    const out: CppCompletionHit[] = [];
    const seen = new Set<string>();
    for (const group of perClass) {
      for (const { s, depth, scope } of group) {
        if (s.name === scope || s.name.startsWith("~") || s.name.startsWith("operator")) continue;
        const kind = hitKind(s.kind);
        if (!kind || seen.has(s.name)) continue;
        seen.add(s.name);
        out.push({ name: s.name, kind, path: s.path, line: s.line, container: scope, depth });
        if (out.length >= MAX_RESULTS) return out;
      }
    }
    return out;
  }
}
