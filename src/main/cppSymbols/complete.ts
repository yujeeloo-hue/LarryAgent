
import { readFileSync, statSync } from "node:fs";
import { memberAccessType } from "../../renderer/src/devmode/cppTextCompletion.js";
import type { CppSymbolDatabase } from "./db.js";
import type { CppCompletionHit, CppCompletionRequest, CppSymbolKind } from "./types.js";

const MAX_BASE_DEPTH = 6;
const MAX_HEAD_LINES = 8;
const BASE_CACHE_TTL_MS = 60_000;
const UE_TYPE_PREFIXES = ["a", "u", "f", "e", "i", "t", "s"];

type Row = {
  name: string;
  kind: string;
  path: string;
  line: number;
  container: string | null;
  container_chain: string | null;
  params: string | null;
  return_type: string | null;
  is_impl: number;
};

const COLUMNS = "name, kind, path, line, container, container_chain, params, return_type, is_impl";

function stripTemplateArgs(text: string): string {
  let out = text;
  for (let n = 0; n < 6; n++) {
    const next = out.replace(/<[^<>]*>/g, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

export function parseBaseClasses(headText: string, className: string): string[] {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b(?:class|struct)\\s+(?:[A-Za-z_]\\w*\\s+)*${escaped}\\b(?:\\s*<[^{;]*?>)?\\s*(?:final\\s*)?([^{;]*)`,
  );
  const match = re.exec(headText);
  if (!match) return [];
  const tail = match[1] ?? "";
  const colon = /(^|[^:]):(?!:)/.exec(tail);
  if (!colon) return [];
  const list = stripTemplateArgs(tail.slice(colon.index + colon[0].length));
  const out: string[] = [];
  for (const part of list.split(",")) {
    const cleaned = part.replace(/\b(?:public|protected|private|virtual)\b/g, " ").trim();
    const segments = cleaned.split("::");
    const name = /([A-Za-z_]\w*)\s*$/.exec(segments[segments.length - 1] ?? "")?.[1];
    if (name && name !== className) out.push(name);
  }
  return out;
}

type FileCache = { mtimeMs: number; lines: string[] };

export class CppCompletionIndex {
  private readonly files = new Map<string, FileCache>();
  private readonly bases = new Map<string, { at: number; names: string[] }>();
  private db!: CppSymbolDatabase;

  private fileLines(path: string): string[] | null {
    try {
      const mtimeMs = statSync(path).mtimeMs;
      const cached = this.files.get(path);
      if (cached && cached.mtimeMs === mtimeMs) return cached.lines;
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      if (this.files.size > 64) this.files.clear();
      this.files.set(path, { mtimeMs, lines });
      return lines;
    } catch {
      return null;
    }
  }

  private directBases(className: string): string[] {
    const cached = this.bases.get(className);
    if (cached && Date.now() - cached.at < BASE_CACHE_TTL_MS) return cached.names;
    const rows = this.db
      .prepare(
        `SELECT path, line FROM symbols
         WHERE name_lower = ? AND name = ? AND kind IN ('class', 'struct', 'interface') LIMIT 8`,
      )
      .all(className.toLowerCase(), className) as { path: string; line: number }[];
    let names: string[] = [];
    for (const row of rows) {
      const lines = this.fileLines(row.path);
      if (!lines) continue;
      const head = lines.slice(Math.max(0, row.line - 1), row.line - 1 + MAX_HEAD_LINES).join(" ");
      names = parseBaseClasses(head, className);
      if (names.length > 0) break;
    }
    this.bases.set(className, { at: Date.now(), names });
    return names;
  }

  classChain(className: string): { name: string; depth: number }[] {
    const out: { name: string; depth: number }[] = [];
    const seen = new Set<string>();
    let frontier = [className];
    for (let depth = 0; depth <= MAX_BASE_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const name of frontier) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, depth });
        next.push(...this.directBases(name));
      }
      frontier = next;
    }
    return out;
  }

  private receiverType(receiver: string, container: string | undefined): string | null {
    const chain = container ? this.classChain(container).map((c) => c.name) : [];
    const rows = this.db
      .prepare(
        `SELECT container, return_type FROM symbols
         WHERE name_lower = ? AND name = ? AND kind = 'variable' AND return_type IS NOT NULL LIMIT 32`,
      )
      .all(receiver.toLowerCase(), receiver) as { container: string | null; return_type: string }[];
    const ranked = rows.sort((a, b) => {
      const ai = a.container ? chain.indexOf(a.container) : -1;
      const bi = b.container ? chain.indexOf(b.container) : -1;
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    for (const row of ranked) {
      const type = memberAccessType(row.return_type);
      if (type) return type;
    }
    return null;
  }

  complete(db: CppSymbolDatabase, request: CppCompletionRequest): CppCompletionHit[] {
    this.db = db;
    const prefix = request.prefix.trim().toLowerCase();
    const limit = Math.max(1, Math.min(request.limit ?? 120, 300));
    const range = prefix
      ? { clause: " AND name_lower >= :lo AND name_lower < :hi", args: { lo: prefix, hi: `${prefix}\uffff` } }
      : { clause: "", args: {} };

    let memberOf = request.memberOf;
    if (memberOf === "Super" && request.container) {
      memberOf = this.directBases(request.container)[0];
      if (!memberOf) return [];
    }
    const fields = [...(request.receiver ? [request.receiver] : []), ...(request.chain ?? [])];
    if (fields.length > 0) {
      let owner = memberOf ?? request.container;
      if (!owner) return [];
      for (const field of fields) {
        const next = this.receiverType(field, owner);
        if (!next) return [];
        owner = next;
      }
      memberOf = owner;
    }

    const out: CppCompletionHit[] = [];
    const seen = new Set<string>();
    const push = (row: Row, depth?: number) => {
      const key = `${row.name}|${row.container ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        name: row.name,
        kind: row.kind as CppSymbolKind,
        path: row.path,
        line: row.line,
        ...(row.container ? { container: row.container } : {}),
        ...(row.container_chain ? { containerChain: row.container_chain } : {}),
        ...(row.params ? { params: row.params } : {}),
        ...(row.return_type ? { returnType: row.return_type } : {}),
        ...(row.is_impl ? { isImpl: true } : {}),
        ...(depth !== undefined ? { depth } : {}),
      });
    };

    const owner = memberOf ?? request.container;
    if (owner) {
      const memberStmt = this.db.prepare(
        `SELECT ${COLUMNS} FROM symbols
         WHERE container = :container AND kind IN ('function', 'variable')${range.clause}
         ORDER BY is_impl, name LIMIT :limit`,
      );
      for (const { name, depth } of this.classChain(owner)) {
        if (out.length >= limit) break;
        const rows = memberStmt.all({ container: name, limit, ...range.args }) as Row[];
        for (const row of rows) push(row, depth);
      }
    }

    if (!memberOf && prefix && out.length < limit) {
      const globalStmt = this.db.prepare(
        `SELECT ${COLUMNS} FROM symbols
         WHERE name_lower >= :lo AND name_lower < :hi
           AND (container IS NULL OR kind IN ('class', 'struct', 'interface', 'enum', 'type'))
         LIMIT :limit`,
      );
      const typePrefixes = /^[a-z]/.test(prefix) ? UE_TYPE_PREFIXES : [];
      for (const lead of ["", ...typePrefixes]) {
        if (out.length >= limit) break;
        const lo = `${lead}${prefix}`;
        const rows = globalStmt.all({ lo, hi: `${lo}\uffff`, limit }) as Row[];
        for (const row of rows) {
          if (out.length >= limit) break;
          if (lead && (row.container !== null || !/^[A-Z]/.test(row.name.slice(1)))) continue;
          push(row);
        }
      }
    }
    return out.slice(0, limit);
  }
}
