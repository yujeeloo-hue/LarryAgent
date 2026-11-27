
export type RankFile = { path: string; rel: string };

export type RankTier = {
  readonly paths: string[];
  readonly rels: string[];
  readonly lowerRels: string[];
  readonly baseStarts: number[];
  readonly demote: boolean;
};

export type RankCursor = {
  readonly query: string;
  readonly tiers: readonly RankTier[];
  readonly matches: number[];
};

export type RankResult = {
  files: RankFile[];
  total: number;
  cursor: RankCursor;
};

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

function isSubsequence(target: string, query: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target.charCodeAt(ti) === query.charCodeAt(qi)) qi++;
  }
  return qi === query.length;
}

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

function encodeId(index: number, tier: number, tierCount: number): number {
  return index * tierCount + tier;
}

export function rankFiles(
  tiers: readonly RankTier[],
  query: string,
  limit: number,
  cursor?: RankCursor | null,
): RankResult {
  const lowered = query.trim().toLowerCase();
  const tierCount = tiers.length;
  const matches: number[] = [];
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
