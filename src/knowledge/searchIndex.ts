import { sectionHeadings } from "./parseDoc.js";
import type { KnowledgeDoc, KnowledgeSearchHit, KnowledgeSearchResult } from "./types.js";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it",
  "of", "on", "or", "the", "this", "to", "use", "using", "what", "when", "with",
]);

const FIELD_WEIGHTS = {
  title: 3,
  keywords: 3,
  summary: 2,
  headings: 1.5,
  body: 1,
} as const;

const K1 = 1.2;
const B = 0.75;

const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]+/g;
const WORD = /[a-z0-9][a-z0-9_.+#-]*/g;

export function tokenizeKnowledgeText(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const match of lower.matchAll(WORD)) {
    const word = match[0].replace(/[.\-+#]+$/g, "");
    if (!word || STOPWORDS.has(word)) continue;
    tokens.push(word);
    if (/[_.\-]/.test(word)) {
      for (const part of word.split(/[_.\-]+/)) {
        if (part && part !== word && !STOPWORDS.has(part)) tokens.push(part);
      }
    }
  }
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

type IndexedDoc = {
  doc: KnowledgeDoc;
  weights: Map<string, number>;
  length: number;
};

export class KnowledgeSearchIndex {
  private readonly docs: IndexedDoc[];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(docs: readonly KnowledgeDoc[]) {
    this.docs = docs.map((doc) => indexDoc(doc));
    let total = 0;
    for (const entry of this.docs) {
      total += entry.length;
      for (const term of entry.weights.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    this.avgLength = this.docs.length > 0 ? total / this.docs.length : 1;
  }

  search(input: { query: string; category?: string; limit: number }): KnowledgeSearchResult {
    const pool = input.category
      ? this.docs.filter((entry) => entry.doc.category === input.category)
      : this.docs;
    const terms = [...new Set(tokenizeKnowledgeText(input.query))];
    const limit = Math.max(1, input.limit);
    if (terms.length === 0) {
      return {
        mode: "list",
        hits: pool.slice(0, limit).map((entry) => ({ doc: entry.doc, score: 0 })),
      };
    }
    const exact = exactToolMatch(pool, input.query);
    const scored = (requireAll: boolean): KnowledgeSearchHit[] => {
      const hits: KnowledgeSearchHit[] = [];
      for (const entry of pool) {
        let score = 0;
        let matched = 0;
        for (const term of terms) {
          const tf = entry.weights.get(term);
          if (!tf) continue;
          matched += 1;
          const df = this.docFreq.get(term) ?? 0;
          const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
          score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * entry.length) / this.avgLength));
        }
        if (matched === 0 || (requireAll && matched < terms.length)) continue;
        if (entry === exact) score += 1_000;
        hits.push({ doc: entry.doc, score });
      }
      hits.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
      return hits.slice(0, limit);
    };
    const all = scored(true);
    if (all.length > 0) return { mode: "and", hits: all };
    return { mode: "or", hits: scored(false) };
  }
}

function exactToolMatch(pool: readonly IndexedDoc[], query: string): IndexedDoc | undefined {
  const name = query.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(name)) return undefined;
  return pool.find((entry) => entry.doc.guideFor.some((tool) => tool.toLowerCase() === name));
}

function addField(weights: Map<string, number>, text: string, weight: number): number {
  const tokens = tokenizeKnowledgeText(text);
  for (const token of tokens) weights.set(token, (weights.get(token) ?? 0) + weight);
  return tokens.length * weight;
}

function indexDoc(doc: KnowledgeDoc): IndexedDoc {
  const weights = new Map<string, number>();
  let length = 0;
  length += addField(weights, `${doc.title} ${doc.slug.replace(/[-_]/g, " ")}`, FIELD_WEIGHTS.title);
  length += addField(
    weights,
    [...doc.keywords, ...doc.guideFor, ...doc.relatedTools].join(" "),
    FIELD_WEIGHTS.keywords,
  );
  length += addField(weights, doc.summary, FIELD_WEIGHTS.summary);
  length += addField(weights, sectionHeadings(doc.body).join(" "), FIELD_WEIGHTS.headings);
  length += addField(weights, doc.body, FIELD_WEIGHTS.body);
  return { doc, weights, length: Math.max(1, length) };
}
