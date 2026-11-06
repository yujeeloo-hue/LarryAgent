/**
 * Quick Open file ranking — pure, DOM-free, so it can run either on the UI
 * thread or inside the search worker.
 *
 * The hot path is "rank every known file on every keystroke". A source-built
 * UE workspace pushes well past 100k entries once the engine tier lands, so
 * this module leans on three things:
 *
 * 1. **Pre-lowercased tiers.** `buildRankTier` pays the `toLowerCase` cost
 *    once per walk instead of once per file per keystroke.
 * 2. **Incremental candidates.** Every scoring rule here is monotonic: if `q2`
 *    extends `q1`, a file matching `q2` always matched `q1` (substring
 *    containment is prefix-closed, and a subsequence stays a subsequence when
 *    you drop trailing query chars). So an extending query only has to re-test
 *    the previous match set, which collapses to a few hundred entries after
 *    two or three characters.
 * 3. **Bucketed selection.** Scores are small integers, so matches are binned
 *    and only the bins needed to fill `limit` get sorted — a broad query no
 *    longer sorts six figures of results to show fifty.
 */

export type RankFile = { path: string; rel: string };

/**
 * One pre-processed file list. Tiers are replaced wholesale (never mutated in
 * place) so a cursor can validate itself by object identity.
 */
export type RankTier = {
  readonly paths: string[];
  readonly rels: string[];
  readonly lowerRels: string[];
  /** Offset of the basename inside `lowerRels[i]` (char after the last "/"). */
  readonly baseStarts: number[];
  /** Rank this tier below undemoted tiers at equal match quality. */
  readonly demote: boolean;
};

/**
 * Carries the previous query's match set so an extending query can skip the
 * full sweep. Bound to the exact tier objects it was computed from.
 */
export type RankCursor = {
  /** Lowercased query the matches belong to. */
  readonly query: string;
  readonly tiers: readonly RankTier[];
  /** Encoded `index * tierCount + tier` ids (see `encodeId`). */
  readonly matches: number[];
};

export type RankResult = {
  files: RankFile[];
  /** Total matches before `limit` — drives the "N results" meta line. */
  total: number;
  cursor: RankCursor;
};

/**
 * Match quality remains the primary key; tier is only a tie-breaker.
 *
 * Encoding `quality * 2 + tier` means an exact Engine basename (1) still
 * beats a project prefix (2), while equal-quality project/Engine hits keep
 * project code first (0 before 1). The previous `score + 5` made *every*
 * project fuzzy hit outrank an exact Engine hit, so Engine files routinely
 * fell beyond the 50-row UI cap unless the user typed `~engine`.
 */
const QUALITY_STRIDE = 2;
const ENGINE_TIE_BREAK = 1;
const MAX_SCORE = 4 * QUALITY_STRIDE + ENGINE_TIE_BREAK;

export function buildRankTier(files: readonly RankFile[], demote: boolean): RankTier {
  const count = files.length;
  const paths = new Array<string>(count);
  const rels = new Array<string>(count);
  const lowerRels = new Array<string>(count);
  const baseStarts = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const file = files[i]!;
    const lower = file.rel.toLowerCase();
    paths[i] = file.path;
    rels[i] = file.rel;
    lowerRels[i] = lower;
    baseStarts[i] = lower.lastIndexOf("/") + 1;
  }
  return { paths, rels, lowerRels, baseStarts, demote };
}

export const EMPTY_TIER: RankTier = buildRankTier([], false);

/**
 * Extend a tier with a streamed batch. The backing arrays grow in place — a
 * fresh wrapper is returned so object identity still changes and any cursor
 * built from the old tier correctly invalidates.
 */
export function appendRankTier(tier: RankTier, files: readonly RankFile[]): RankTier {
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const lower = file.rel.toLowerCase();
    tier.paths.push(file.path);
    tier.rels.push(file.rel);
    tier.lowerRels.push(lower);
    tier.baseStarts.push(lower.lastIndexOf("/") + 1);
  }
  return { ...tier };
}

/** Case-insensitive subsequence match — the VS Code "ctrl+p fuzzy" feel. */
export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  return isSubsequence(target.toLowerCase(), query.toLowerCase());
}

export type RankSymbol = {
  name: string;
  path: string;
  rel: string;
  line: number;
  symbolKind: string;
  container?: string;
};

/**
 * Rank workspace symbols by name: exact → prefix → substring → fuzzy.
 * Functions sort ahead of types at equal quality so Ctrl/T function-name
 * queries surface methods before similarly named classes/files.
 */
export function rankSymbols(
  entries: readonly RankSymbol[],
  query: string,
  limit: number,
): RankSymbol[] {
  const q = query.trim().toLowerCase();
  if (!q || limit <= 0) return [];
  const bins: RankSymbol[][] = [[], [], [], []];
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    let score: number;
    if (lower === q) score = 0;
    else if (lower.startsWith(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (isSubsequence(lower, q)) score = 3;
    else continue;
    bins[score]!.push(entry);
  }
  const out: RankSymbol[] = [];
  for (let score = 0; score < bins.length && out.length < limit; score++) {
    const bin = bins[score]!;
    bin.sort((a, b) => {
      const af = a.symbolKind === "function" ? 0 : 1;
      const bf = b.symbolKind === "function" ? 0 : 1;
      if (af !== bf) return af - bf;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      const ac = a.container ?? "";
      const bc = b.container ?? "";
      if (ac !== bc) return ac.localeCompare(bc);
      return a.rel.localeCompare(b.rel);
    });
    for (let i = 0; i < bin.length && out.length < limit; i++) {
      out.push(bin[i]!);
    }
  }
  return out;
}

/** Subsequence test on operands the caller already lowercased. */
function isSubsequence(target: string, query: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target.charCodeAt(ti) === query.charCodeAt(qi)) qi++;
  }
  return qi === query.length;
}

/**
 * Match quality for one entry, or -1 when it does not match.
 *
 * 0 exact basename · 1 basename prefix · 2 basename substring ·
 * 3 path substring · 4 fuzzy subsequence. The returned bucket score encodes
 * quality first and the demoted Engine tier second.
 * Deliberately avoids slicing out the basename: `indexOf` with a start
 * offset answers the first three rules without allocating per entry.
 */
function scoreOf(tier: RankTier, index: number, query: string): number {
  const lower = tier.lowerRels[index]!;
  const baseStart = tier.baseStarts[index]!;
  let score: number;
  const inBase = lower.indexOf(query, baseStart);
  if (inBase === baseStart) {
    score = baseStart + query.length === lower.length ? 0 : 1;
  } else if (inBase !== -1) {
    score = 2;
  } else if (lower.indexOf(query) !== -1) {
    score = 3;
  } else if (isSubsequence(lower, query)) {
    score = 4;
  } else {
    return -1;
  }
  return score * QUALITY_STRIDE + (tier.demote ? ENGINE_TIE_BREAK : 0);
}

/** Pack a (tier, index) pair into one integer to keep the hot loop allocation-free. */
function encodeId(index: number, tier: number, tierCount: number): number {
  return index * tierCount + tier;
}

/**
 * Rank `tiers` against `query` and return the best `limit` files.
 *
 * Pass the previous call's `cursor` to enable incremental filtering; it is
 * ignored unless it was produced from the same tier objects and its query is
 * a prefix of this one.
 */
export function rankFiles(
  tiers: readonly RankTier[],
  query: string,
  limit: number,
  cursor?: RankCursor | null,
): RankResult {
  const lowered = query.trim().toLowerCase();
  const tierCount = tiers.length;
  const matches: number[] = [];
  // One bin per attainable score; each holds encoded ids in discovery order.
  const bins: number[][] = [];
  for (let s = 0; s <= MAX_SCORE; s++) bins.push([]);

  const take = (id: number): void => {
    const tierIndex = id % tierCount;
    const index = (id - tierIndex) / tierCount;
    const score = scoreOf(tiers[tierIndex]!, index, lowered);
    if (score < 0) return;
    matches.push(id);
    bins[score]!.push(id);
  };

  const reusable =
    cursor != null &&
    cursor.tiers.length === tierCount &&
    lowered.startsWith(cursor.query) &&
    tiers.every((tier, i) => cursor.tiers[i] === tier);

  if (reusable) {
    const previous = cursor.matches;
    for (let i = 0; i < previous.length; i++) take(previous[i]!);
  } else {
    for (let t = 0; t < tierCount; t++) {
      const size = tiers[t]!.rels.length;
      for (let i = 0; i < size; i++) take(encodeId(i, t, tierCount));
    }
  }

  // Only sort the bins we actually consume; a one-letter query can fill the
  // page out of bin 0 and leave six figures of fuzzy hits untouched.
  const files: RankFile[] = [];
  for (let score = 0; score <= MAX_SCORE && files.length < limit; score++) {
    const bin = bins[score]!;
    if (bin.length === 0) continue;
    bin.sort((a, b) => {
      const at = a % tierCount;
      const bt = b % tierCount;
      const ar = tiers[at]!.rels[(a - at) / tierCount]!;
      const br = tiers[bt]!.rels[(b - bt) / tierCount]!;
      if (ar.length !== br.length) return ar.length - br.length;
      return ar.localeCompare(br);
    });
    for (let i = 0; i < bin.length && files.length < limit; i++) {
      const id = bin[i]!;
      const tierIndex = id % tierCount;
      const index = (id - tierIndex) / tierCount;
      const tier = tiers[tierIndex]!;
      files.push({ path: tier.paths[index]!, rel: tier.rels[index]! });
    }
  }

  return {
    files,
    total: matches.length,
    cursor: { query: lowered, tiers: [...tiers], matches },
  };
}
