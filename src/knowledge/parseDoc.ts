import type { KnowledgeSection } from "./types.js";

export type FrontmatterValue = string | string[];

export type ParsedFrontmatter = {
  fields: Record<string, FrontmatterValue>;
  body: string;
  hasFrontmatter: boolean;
};

export type KnowledgeFrontmatter = {
  title: string;
  category: string;
  summary: string;
  keywords: string[];
  relatedTools: string[];
  guideFor: string[];
  version?: number;
  updatedAt?: string;
  baseVersion?: number;
};

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1);
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
    }
  }
  return value;
}

function splitInlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map(unquote).map((s) => s.trim()).filter(Boolean);
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^\uFEFF/, "");
  const start = text.match(/^---[ \t]*\r?\n/);
  if (!start) return { fields: {}, body: text.trim(), hasFrontmatter: false };
  const rest = text.slice(start[0].length);
  const close = rest.match(/(^|\r?\n)---[ \t]*(\r?\n|$)/);
  if (!close || close.index === undefined) {
    return { fields: {}, body: text.trim(), hasFrontmatter: false };
  }
  const front = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  const fields: Record<string, FrontmatterValue> = {};
  let listKey: string | null = null;
  for (const line of front.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/) ?? line.match(/^-\s+(.*)$/);
    if (item && listKey) {
      const list = fields[listKey];
      const value = unquote(item[1] ?? "");
      if (Array.isArray(list) && value) list.push(value);
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = (match[2] ?? "").trim();
    if (!value) {
      fields[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    fields[key] = value.startsWith("[") && value.endsWith("]") ? splitInlineList(value) : unquote(value);
  }
  return { fields, body: body.replace(/^\s*\r?\n/, "").replace(/\s+$/, ""), hasFrontmatter: true };
}

function asString(value: FrontmatterValue | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join(", ") : value;
}

function asList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : value.split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const item = raw.trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
  }
  return out;
}

function asInt(value: FrontmatterValue | undefined): number | undefined {
  const text = asString(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function readKnowledgeFrontmatter(fields: Record<string, FrontmatterValue>): KnowledgeFrontmatter {
  const version = asInt(fields.version);
  const baseVersion = asInt(fields.base_version);
  const updatedAt = asString(fields.updated_at).trim();
  return {
    title: asString(fields.title).trim(),
    category: asString(fields.category).trim(),
    summary: asString(fields.summary).replace(/\s+/g, " ").trim(),
    keywords: asList(fields.keywords),
    relatedTools: asList(fields.related_tools),
    guideFor: asList(fields.guide_for),
    ...(version !== undefined ? { version } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  };
}

function yamlScalar(value: string): string {
  if (/^[^\s"'#\[\]{},:&*!|>%@`-][^#:]*$/.test(value) && !/\s$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlList(values: readonly string[]): string {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

export function serializeKnowledgeDoc(front: KnowledgeFrontmatter, body: string): string {
  const lines = [
    "---",
    `title: ${yamlScalar(front.title)}`,
    `category: ${front.category}`,
    `summary: ${yamlScalar(front.summary)}`,
    `keywords: ${yamlList(front.keywords)}`,
  ];
  if (front.relatedTools.length > 0) lines.push(`related_tools: ${yamlList(front.relatedTools)}`);
  if (front.guideFor.length > 0) lines.push(`guide_for: ${yamlList(front.guideFor)}`);
  if (front.version !== undefined) lines.push(`version: ${front.version}`);
  if (front.updatedAt) lines.push(`updated_at: ${front.updatedAt}`);
  if (front.baseVersion !== undefined) lines.push(`base_version: ${front.baseVersion}`);
  lines.push("---", "");
  return `${lines.join("\n")}${body.replace(/\s+$/, "")}\n`;
}

export function splitSections(body: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let heading = "";
  let buffer: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (heading || text) sections.push({ heading, text });
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence ? line.match(/^##\s+(.+?)\s*#*\s*$/) : null;
    if (match) {
      flush();
      heading = match[1]!.trim();
      buffer = [line];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

export function sectionHeadings(body: string): string[] {
  return splitSections(body).map((s) => s.heading).filter(Boolean);
}

export function findSection(body: string, query: string): KnowledgeSection | null {
  const wanted = query.trim().replace(/^#+\s*/, "").toLowerCase();
  if (!wanted) return null;
  const sections = splitSections(body).filter((s) => s.heading);
  return (
    sections.find((s) => s.heading.toLowerCase() === wanted) ??
    sections.find((s) => s.heading.toLowerCase().includes(wanted)) ??
    null
  );
}
