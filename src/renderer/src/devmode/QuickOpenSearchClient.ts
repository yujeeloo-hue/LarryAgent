import {
  QuickOpenSearchIndex,
  type QuickOpenQueryResult,
  type QuickOpenTierId,
  type QuickOpenWorkerRequest,
  type QuickOpenWorkerResponse,
} from "./quickOpenIndex.js";
import type { RankFile } from "./quickOpenRank.js";

export class QuickOpenSearchClient {
  private worker: Worker | null = null;
  private inline: QuickOpenSearchIndex | null = null;
  private nextQueryId = 0;
  private readonly tierFiles: Record<QuickOpenTierId, RankFile[]> = {
    project: [],
    engine: [],
  };
  private readonly pending = new Map<
    number,
    {
      resolve: (result: QuickOpenQueryResult) => void;
      query: string;
      limit: number;
      engineOnly: boolean;
      includeEngine: boolean;
    }
  >();

  constructor() {
    try {
      this.worker = new Worker(
        new URL("./quickOpenSearch.worker.js", import.meta.url),
        { type: "module" },
      );
      this.worker.onmessage = (
        event: MessageEvent<QuickOpenWorkerResponse>,
      ): void => {
        const { id, files, total, counts } = event.data;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.resolve({ files, total, counts });
      };
      this.worker.onerror = (): void => this.degrade();
    } catch {
      this.inline = new QuickOpenSearchIndex();
    }
  }

  private degrade(): void {
    this.worker?.terminate();
    this.worker = null;
    this.inline = new QuickOpenSearchIndex();
    this.inline.setTier("project", this.tierFiles.project);
    this.inline.setTier("engine", this.tierFiles.engine);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.resolve(
        this.inline.query(
          pending.query,
          pending.limit,
          pending.engineOnly,
          pending.includeEngine,
        ),
      );
    }
  }

  private post(message: QuickOpenWorkerRequest): void {
    this.worker?.postMessage(message);
  }

  reset(): void {
    this.tierFiles.project = [];
    this.tierFiles.engine = [];
    this.inline?.reset();
    this.post({ type: "reset" });
  }

  setTier(tier: QuickOpenTierId, files: RankFile[]): void {
    this.tierFiles[tier] = [...files];
    this.inline?.setTier(tier, files);
    this.post({ type: "setTier", tier, files });
  }

  appendTier(tier: QuickOpenTierId, files: RankFile[]): void {
    this.tierFiles[tier].push(...files);
    this.inline?.appendTier(tier, files);
    this.post({ type: "appendTier", tier, files });
  }

  async query(
    query: string,
    limit: number,
    engineOnly: boolean,
    includeEngine = true,
  ): Promise<QuickOpenQueryResult> {
    if (this.inline) {
      return this.inline.query(query, limit, engineOnly, includeEngine);
    }
    const id = ++this.nextQueryId;
    return new Promise<QuickOpenQueryResult>((resolve) => {
      this.pending.set(id, { resolve, query, limit, engineOnly, includeEngine });
      this.post({ type: "query", id, query, limit, engineOnly, includeEngine });
    });
  }

  filesByBasename(base: string): RankFile[] {
    const lower = base.trim().toLowerCase();
    if (!lower) return [];
    const out: RankFile[] = [];
    for (const tier of ["project", "engine"] as const) {
      for (const file of this.tierFiles[tier]) {
        const name = file.rel.slice(file.rel.lastIndexOf("/") + 1);
        const dot = name.lastIndexOf(".");
        if (dot > 0 && name.slice(0, dot).toLowerCase() === lower) {
          out.push(file);
        }
      }
    }
    return out;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.inline = null;
    this.pending.clear();
  }
}
