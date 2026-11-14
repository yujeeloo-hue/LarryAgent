/**
 * Lexical skill similarity (no embeddings). BM25 ranks skills against free
 * text; TF-IDF cosine compares skills pairwise for curation clusters.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in",
  "into", "is", "it", "its", "of", "on", "or", "that", "the", "this", "to",
  "use", "used", "using", "when", "with", "you", "your", "skill", "skills",
]);

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/** Lowercase ASCII words (≥2 chars, no stopwords) plus CJK character bigrams. */
export function tokenizeForSimilarity(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9][a-z0-9_]*/g) ?? []) {
    for (const part of word.split("_")) {
      if (part.length >= 2 && !STOPWORDS.has(part)) out.push(part);
    }
  }
  let run = "";
  const flush = (): void => {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
    run = "";
  };
  for (const ch of lower) {
    if (CJK_RE.test(ch)) run += ch;
    else if (run) flush();
  }
  if (run) flush();
  return out;
}

export type SimilarityDoc = { id: string; text: string };

/** Name (weighted twice) + description + markdown headings of the body. */
export function skillSimilarityText(skill: {
  name: string;
  description: string;
  body?: string;
}): string {
  const name = skill.name.replace(/-/g, " ");
  const headings = (skill.body ?? "")
    .split("\n")
    .filter((line) => /^#{1,4}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, ""))
    .join(" ");
  return `${name} ${name} ${skill.description} ${headings}`;
}

type Indexed = { id: string; tf: Map<string, number>; length: number };

function index(docs: SimilarityDoc[]): { items: Indexed[]; df: Map<string, number> } {
  const df = new Map<string, number>();
  const items = docs.map((doc) => {
    const tokens = tokenizeForSimilarity(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { id: doc.id, tf, length: tokens.length };
  });
  return { items, df };
}

function idf(df: Map<string, number>, n: number, term: string): number {
  const d = df.get(term) ?? 0;
  return Math.log(1 + (n - d + 0.5) / (d + 0.5));
}

/** BM25 (k1 = 1.2, b = 0.75); zero-score docs are dropped. */
export function rankBySimilarity(
  query: string,
  docs: SimilarityDoc[],
  limit = docs.length,
): Array<{ id: string; score: number }> {
  const terms = [...new Set(tokenizeForSimilarity(query))];
  if (terms.length === 0 || docs.length === 0) return [];
  const { items, df } = index(docs);
  const avg = items.reduce((sum, d) => sum + d.length, 0) / items.length || 1;
  const k1 = 1.2;
  const b = 0.75;
  const scored = items.map((doc) => {
    let score = 0;
    for (const term of terms) {
      const f = doc.tf.get(term) ?? 0;
      if (f === 0) continue;
      score +=
        idf(df, items.length, term) *
        ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avg)));
    }
    return { id: doc.id, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id))
    .slice(0, Math.max(0, limit));
}

/** TF-IDF cosine for every pair with score ≥ `minScore`, highest first. */
export function pairwiseSimilarities(
  docs: SimilarityDoc[],
  minScore = 0,
): Array<{ a: string; b: string; score: number }> {
  const { items, df } = index(docs);
  const n = items.length;
  const vectors = items.map((doc) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [term, f] of doc.tf) {
      const w = (1 + Math.log(f)) * Math.log((n + 1) / ((df.get(term) ?? 0) + 0.5));
      if (w <= 0) continue;
      v.set(term, w);
      norm += w * w;
    }
    return { id: doc.id, v, norm: Math.sqrt(norm) };
  });
  const out: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const x = vectors[i]!;
      const y = vectors[j]!;
      if (x.norm === 0 || y.norm === 0) continue;
      const [small, large] = x.v.size <= y.v.size ? [x, y] : [y, x];
      let dot = 0;
      for (const [term, w] of small.v) dot += w * (large.v.get(term) ?? 0);
      const score = dot / (x.norm * y.norm);
      if (score >= minScore) out.push({ a: x.id, b: y.id, score });
    }
  }
  return out.sort((p, q) => q.score - p.score);
}

/**
 * Connected components over pairs ≥ threshold, keeping components of size
 * 2..maxSize (larger ones are split by dropping the weakest links first).
 */
export function similarityClusters(
  docs: SimilarityDoc[],
  threshold: number,
  maxSize = 4,
): string[][] {
  const pairs = pairwiseSimilarities(docs, threshold);
  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  for (const d of docs) {
    parent.set(d.id, d.id);
    size.set(d.id, 1);
  }
  for (const pair of pairs) {
    const ra = find(pair.a);
    const rb = find(pair.b);
    if (ra === rb) continue;
    if ((size.get(ra) ?? 1) + (size.get(rb) ?? 1) > maxSize) continue;
    parent.set(rb, ra);
    size.set(ra, (size.get(ra) ?? 1) + (size.get(rb) ?? 1));
  }
  const groups = new Map<string, string[]>();
  for (const d of docs) {
    const root = find(d.id);
    groups.set(root, [...(groups.get(root) ?? []), d.id]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}
