/**
 * Quick Open search index + worker protocol.
 *
 * Kept separate from `quickOpenSearch.worker.ts` so the controller can import
 * the class for its in-thread fallback without pulling the worker's
 * `self.onmessage` wiring into the window bundle.
 */
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
      /** Restrict results to the engine tier (`~engine` prefix). */
      engineOnly: boolean;
    };

export type QuickOpenQueryResult = {
  files: RankFile[];
  /** Total matches before `limit` — drives the "N results" meta line. */
  total: number;
  /** Index sizes at answer time. */
  counts: { project: number; engine: number };
};

export type QuickOpenWorkerResponse = {
  type: "results";
  id: number;
} & QuickOpenQueryResult;

/**
 * Ranking state shared by the worker and the in-thread fallback, so the two
 * paths cannot drift apart behaviourally.
 */
export class QuickOpenSearchIndex {
  private project: RankTier = EMPTY_TIER;
  // Engine code ranks below project code at equal match quality.
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
    // Tier identity changed; the previous match set no longer describes it.
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

  query(query: string, limit: number, engineOnly: boolean): QuickOpenQueryResult {
    const tiers = engineOnly ? [this.engine] : [this.project, this.engine];
    const result = rankFiles(tiers, query, limit, this.cursor);
    this.cursor = result.cursor;
    return { files: result.files, total: result.total, counts: this.counts() };
  }
}
