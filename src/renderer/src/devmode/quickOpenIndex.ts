import {
  appendRankTier,
  buildRankTier,
  EMPTY_TIER,
  rankFiles,
  type RankCursor,
  type RankFile,
  type RankTier,
} from "./quickOpenRank.js";

export type QuickOpenTierId = "project" | "engine";

export type QuickOpenWorkerRequest =
  | { type: "reset" }
  | { type: "setTier"; tier: QuickOpenTierId; files: RankFile[] }
  | { type: "appendTier"; tier: QuickOpenTierId; files: RankFile[] }
  | {
      type: "query";
      id: number;
      query: string;
      limit: number;
      engineOnly: boolean;
      includeEngine?: boolean;
    };

export type QuickOpenQueryResult = {
  files: RankFile[];
  total: number;
  counts: { project: number; engine: number };
};

export type QuickOpenWorkerResponse = {
  type: "results";
  id: number;
} & QuickOpenQueryResult;

export class QuickOpenSearchIndex {
  private project: RankTier = EMPTY_TIER;
  private engine: RankTier = buildRankTier([], true);
  private cursor: RankCursor | null = null;

  reset(): void {
    this.project = EMPTY_TIER;
    this.engine = buildRankTier([], true);
    this.cursor = null;
  }

  setTier(tier: QuickOpenTierId, files: readonly RankFile[]): void {
    if (tier === "project") this.project = buildRankTier(files, false);
    else this.engine = buildRankTier(files, true);
    this.cursor = null;
  }

  appendTier(tier: QuickOpenTierId, files: readonly RankFile[]): void {
    if (files.length === 0) return;
    if (tier === "project") this.project = appendRankTier(this.project, files);
    else this.engine = appendRankTier(this.engine, files);
    this.cursor = null;
  }

  counts(): { project: number; engine: number } {
    return {
      project: this.project.rels.length,
      engine: this.engine.rels.length,
    };
  }

  query(query: string, limit: number, engineOnly: boolean, includeEngine = true): QuickOpenQueryResult {
    const tiers = engineOnly ? [this.engine] : includeEngine ? [this.project, this.engine] : [this.project];
    const result = rankFiles(tiers, query, limit, this.cursor);
    this.cursor = result.cursor;
    return { files: result.files, total: result.total, counts: this.counts() };
  }
}
